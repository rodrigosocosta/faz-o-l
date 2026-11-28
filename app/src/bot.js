import { logger } from './logger.js';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config.js';
import { allChannels, createInvite, discordBridge, getChannelByGuild, memberRole, updateGuildInfo } from './channels.js';
import { sql } from './db.js';
import { getRoomState, liveEvents } from './livekit.js';

const COLOR_LIVE = 0xed4245;
const COLOR_IDLE = 0x5865f2;
const COLOR_ENDED = 0x4f545c;
// Bot entrou num servidor sem ser pelo botão "Criar canal" do site: sai depois disso
const UNKNOWN_GUILD_GRACE_MS = 60_000;

const channelUrl = (channel) => `${config.publicUrl}/c/${channel.id}`;
const lengthLabel = (seconds) => {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m ? (s ? `${m} min ${s} s` : `${m} min`) : `${s} s`;
};
const iconUrl = (guild) => guild.iconURL({ size: 128, extension: 'png' }) || '';

function watchButton(channel, label = 'Assistir agora') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(channelUrl(channel)).setEmoji('📺'),
  );
}

async function statusEmbed(channel) {
  const state = await getRoomState(channel);
  const live = state.streamers.filter((s) => s.live);
  const embed = new EmbedBuilder()
    .setTitle(`Faz o L • ${channel.name}`)
    .setURL(channelUrl(channel))
    .setColor(live.length ? COLOR_LIVE : COLOR_IDLE);

  if (live.length) {
    embed.setDescription(live.map((s) => `🔴 **${s.name}** está ao vivo`).join('\n'));
  } else {
    embed.setDescription('Ninguém transmitindo agora. Entre no site e seja o primeiro!');
  }
  embed.addFields(
    { name: 'Transmitindo', value: `${live.length}/${state.maxStreamers}`, inline: true },
    { name: 'Assistindo', value: `${state.viewers}/${state.maxViewers}`, inline: true },
  );
  return embed;
}

export async function startBot() {
  const { botToken, guildId: legacyGuildId } = config.discord;
  if (!botToken) {
    logger.info('[bot] DISCORD_BOT_TOKEN não definido — bot desativado.');
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const notifications = new Map(); // "<canal>|<identity>" -> Message

  const commands = [
    new SlashCommandBuilder().setName('live').setDescription('Mostra quem está transmitindo e o link para assistir'),
    new SlashCommandBuilder().setName('convite').setDescription('Cria um link de convite para o canal do Faz o L (só o dono)'),
  ].map((c) => c.toJSON());

  // ---------- ponte para o site ----------

  discordBridge.listTextChannels = async (guildId) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return [];
    const channels = await guild.channels.fetch();
    const me = guild.members.me;
    return [...channels.values()]
      .filter((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
      .filter((c) => c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name }));
  };

  discordBridge.leaveGuild = async (guildId) => {
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
    if (guild) {
      await guild.leave();
      logger.info(`[bot] Saiu do servidor ${guild.name} (sem permissão para criar canal)`);
    }
  };

  // ---------- presença / comandos ----------

  async function updatePresence() {
    if (!client.isReady()) return;
    let live = 0;
    let viewers = 0;
    for (const channel of allChannels()) {
      const state = await getRoomState(channel);
      live += state.streamers.filter((s) => s.live).length;
      viewers += state.viewers;
    }
    client.user.setPresence({
      status: live ? 'online' : 'idle',
      activities: [
        { type: ActivityType.Watching, name: live ? `${live} ao vivo • ${viewers} assistindo` : 'ninguém ao vivo • /live' },
      ],
    });
  }

  async function registerCommands() {
    try {
      await client.application.commands.set(commands);
      // Comandos da versão antiga (registrados só num servidor) duplicariam os globais
      if (legacyGuildId) await client.application.commands.set([], legacyGuildId).catch(() => {});
      logger.info('[bot] Comandos /live e /convite registrados.');
    } catch (err) {
      logger.error('[bot] Falha ao registrar comandos:', err);
    }
  }

  client.once(Events.ClientReady, async (c) => {
    logger.info(`[bot] Conectado como ${c.user.tag}`);
    await registerCommands();
    for (const guild of c.guilds.cache.values()) {
      if (getChannelByGuild(guild.id)) updateGuildInfo(guild.id, { name: guild.name, icon: iconUrl(guild) });
      else logger.info(`[bot] Servidor ${guild.name} (${guild.id}) não tem canal do Faz o L`);
    }
    updatePresence().catch(() => {});
  });

  client.on(Events.GuildCreate, (guild) => {
    logger.info(`[bot] Entrou no servidor ${guild.name}`);
    if (getChannelByGuild(guild.id)) return updateGuildInfo(guild.id, { name: guild.name, icon: iconUrl(guild) });
    // O canal é criado no retorno do "Criar canal" do site; se não vier, não era pra estar aqui
    setTimeout(() => {
      if (!getChannelByGuild(guild.id)) discordBridge.leaveGuild(guild.id).catch(() => {});
    }, UNKNOWN_GUILD_GRACE_MS);
  });

  client.on(Events.GuildUpdate, (_old, guild) => {
    updateGuildInfo(guild.id, { name: guild.name, icon: iconUrl(guild) });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const channel = interaction.guildId && getChannelByGuild(interaction.guildId);
    if (!channel) {
      return interaction.reply({ content: 'Este servidor ainda não tem um canal do Faz o L.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    try {
      if (interaction.commandName === 'live') {
        await interaction.reply({ embeds: [await statusEmbed(channel)], components: [watchButton(channel)] });
      } else if (interaction.commandName === 'convite') {
        if (memberRole(channel.id, `d${interaction.user.id}`) !== 'owner') {
          return interaction.reply({ content: 'Só quem colocou o bot no servidor pode convidar.', flags: MessageFlags.Ephemeral });
        }
        const invite = createInvite(channel.id, `d${interaction.user.id}`, { days: 7 });
        await interaction.reply({
          content: `Convite para **${channel.name}** (vale 7 dias):\n${invite.url}`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      logger.error(`[bot] /${interaction.commandName}:`, err);
    }
  });

  // ---------- avisos ----------

  async function textChannel(id, guildId) {
    if (!id || !guildId || !client.isReady()) return null;
    try {
      const channel = await client.channels.fetch(id);
      return channel?.isTextBased() && channel.guildId === guildId ? channel : null;
    } catch (err) {
      logger.error('[bot] Canal de texto inválido:', id, err);
      return null;
    }
  }

  /**
   * Nome de exibição no Discord. Se só tivermos o id (identity "d<id>" ou
   * "d<id>:tela"), busca o usuário no servidor: apelido > nome global > username.
   */
  async function resolveName(guildId, identity, name) {
    const match = /^d(\d+)(?::tela)?$/.exec(identity || '');
    if (!match || (name && name !== identity && name !== identity.replace(/:tela$/, ''))) return name;
    const userId = match[1];
    try {
      const member = guildId ? await client.guilds.cache.get(guildId)?.members.fetch(userId) : null;
      if (member) return member.displayName;
      const user = await client.users.fetch(userId);
      return user.globalName || user.username;
    } catch {
      return name || 'alguém';
    }
  }

  liveEvents.on('stream:start', async ({ channel, identity, name: rawName }) => {
    updatePresence().catch(() => {});
    const target = await textChannel(channel.notify_channel_id, channel.guild_id);
    if (!target) return;
    const name = await resolveName(channel.guild_id, identity, rawName);
    const embed = new EmbedBuilder()
      .setColor(COLOR_LIVE)
      .setTitle(`🔴 ${name} está ao vivo!`)
      .setURL(channelUrl(channel))
      .setDescription('Clique no botão para assistir com quase zero de delay.')
      .setTimestamp();
    try {
      const msg = await target.send({ embeds: [embed], components: [watchButton(channel)] });
      notifications.set(`${channel.id}|${identity}`, msg);
    } catch (err) {
      logger.error('[bot] Falha ao enviar aviso:', err);
    }
  });

  liveEvents.on('stream:end', async ({ channel, identity, name: rawName }) => {
    updatePresence().catch(() => {});
    const k = `${channel.id}|${identity}`;
    const msg = notifications.get(k);
    if (!msg) return;
    notifications.delete(k);
    const name = await resolveName(channel.guild_id, identity, rawName);
    const embed = new EmbedBuilder().setColor(COLOR_ENDED).setTitle(`${name} encerrou a transmissão`).setTimestamp();
    msg.edit({ embeds: [embed], components: [] }).catch(() => {});
  });

  // Evento (YouTube/Twitch assistido junto): avisa no canal de avisos e marca como encerrado depois
  const eventMessages = new Map(); // id do canal -> mensagem
  liveEvents.on('event:start', async ({ channel, event }) => {
    const target = await textChannel(channel.notify_channel_id, channel.guild_id);
    if (!target) return;
    const embed = new EmbedBuilder()
      .setColor(COLOR_LIVE)
      .setTitle(`🎬 Evento: ${event.title}`.slice(0, 256))
      .setURL(channelUrl(channel))
      .setDescription(`${event.by.name} começou um evento. Todo mundo assiste junto, no mesmo ponto do vídeo.`)
      .setTimestamp();
    if (event.videoId) embed.setThumbnail(`https://i.ytimg.com/vi/${event.videoId}/hqdefault.jpg`);
    try {
      eventMessages.set(channel.id, await target.send({ embeds: [embed], components: [watchButton(channel)] }));
    } catch (err) {
      logger.error('[bot] Falha ao avisar evento:', err);
    }
  });
  liveEvents.on('event:end', ({ channel, event }) => {
    const msg = eventMessages.get(channel.id);
    if (!msg) return;
    eventMessages.delete(channel.id);
    const embed = new EmbedBuilder().setColor(COLOR_ENDED).setTitle(`Evento encerrado: ${event.title}`.slice(0, 256)).setTimestamp();
    msg.edit({ embeds: [embed], components: [] }).catch(() => {});
  });

  // Cada clipe vai pro canal de clipes (ou de avisos); o link abre o vídeo embutido no Discord.
  // As pessoas marcadas com @ no título/descrição recebem a menção.
  /** Texto do post do clipe: título, quem clipou, descrição e link (com versão, pro Discord refazer a prévia). */
  async function clipMessage(channel, clip, version = '') {
    const [streamer, creator] = await Promise.all([
      resolveName(channel.guild_id, clip.streamer_id, clip.streamer_name),
      resolveName(channel.guild_id, clip.creator_id, clip.creator_name),
    ]);
    const discordIds = new Map(
      clip.mentions.filter((u) => u.id.startsWith('d') && u.username).map((u) => [u.username.toLowerCase(), u.id.slice(1)]),
    );
    const withMentions = (text) =>
      text.replace(/@([a-z0-9_.]{2,32})/gi, (all, raw) => {
        const id = discordIds.get(raw.replace(/\.+$/, '').toLowerCase());
        return id ? `<@${id}>${raw.match(/\.+$/)?.[0] || ''}` : all;
      });

    const who = creator === streamer ? `**${creator}** clipou a própria live` : `**${creator}** clipou a live de **${streamer}**`;
    const lines = [];
    if (clip.title) lines.push(`✂️ **${withMentions(clip.title)}**`, `${who} (${lengthLabel(clip.seconds)})`);
    else lines.push(`✂️ ${who} (${lengthLabel(clip.seconds)})`);
    // descrição em citação ("> " por linha), logo abaixo do título
    if (clip.description) lines.push(...withMentions(clip.description).split('\n').map((l) => `> ${l}`));
    const link = `${config.publicUrl}/clip/${clip.id}${version ? `?v=${version}` : ''}`;
    const content = `${lines.join('\n').slice(0, 1990 - link.length)}\n${link}`;
    return { content, allowedMentions: { users: [...discordIds.values()] } };
  }

  liveEvents.on('clip:published', async ({ channel, clip }) => {
    const target = await textChannel(channel.clips_channel_id || channel.notify_channel_id, channel.guild_id);
    if (!target) return;
    try {
      const msg = await target.send(await clipMessage(channel, clip));
      sql('UPDATE clips SET discord_message = ? WHERE id = ?').run(`${target.id}:${msg.id}`, clip.id);
    } catch (err) {
      logger.error('[bot] Falha ao postar clipe:', err);
    }
  });

  // Título/descrição editados depois de postar: edita a mensagem
  liveEvents.on('clip:updated', async ({ channel, clip }) => {
    const [channelId, messageId] = String(clip.discord_message || '').split(':');
    if (!messageId) return;
    try {
      const target = await textChannel(channelId, channel.guild_id);
      const msg = await target?.messages.fetch(messageId);
      if (!msg) return;
      await msg.edit({ ...(await clipMessage(channel, clip, Date.now().toString(36))), allowedMentions: { parse: [] } });
    } catch (err) {
      logger.error('[bot] Falha ao atualizar post do clipe:', err);
    }
  });

  let presenceTimer;
  liveEvents.on('room:update', () => {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => updatePresence().catch(() => {}), 2000);
  });

  await client.login(botToken);
}
