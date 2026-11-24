import { logger } from './logger.js';
const env = process.env;

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function required(name) {
  const value = env[name];
  if (!value) {
    logger.error(`[config] Variável obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return value;
}

const port = int(env.PORT, 3000);
const publicUrl = (env.PUBLIC_URL || (env.DOMAIN ? `https://${env.DOMAIN}` : `http://localhost:${port}`)).replace(/\/+$/, '');

const discord = {
  clientId: env.DISCORD_CLIENT_ID || '',
  clientSecret: env.DISCORD_CLIENT_SECRET || '',
  guildId: env.DISCORD_GUILD_ID || '',
  botToken: env.DISCORD_BOT_TOKEN || '',
  notifyChannelId: env.DISCORD_NOTIFY_CHANNEL_ID || '',
  // Canal onde o bot posta o link de cada clipe (vazio = usa o canal de avisos)
  clipsChannelId: env.DISCORD_CLIPS_CHANNEL_ID || '',
  // Quem pode colocar o bot num servidor e criar um canal (ids de usuário do Discord, separados por vírgula)
  creatorIds: (env.CREATOR_DISCORD_IDS || '').split(/[\s,]+/).filter((id) => /^\d{5,25}$/.test(id)),
};

export const config = {
  port,
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  sessionSecret: required('SESSION_SECRET'),
  room: env.ROOM_NAME || 'faz-o-l',
  maxStreamers: int(env.MAX_STREAMERS, 2),
  maxViewers: int(env.MAX_VIEWERS, 15),
  livekit: {
    host: env.LIVEKIT_HOST || 'http://localhost:7880',
    // URL que o navegador usa. Vazio = mesmo domínio do site (via Caddy).
    publicUrl: env.LIVEKIT_PUBLIC_URL || '',
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
  },
  discord,
  authMode: discord.clientId && discord.clientSecret ? 'discord' : 'guest',
};
