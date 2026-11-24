import { logger } from './logger.js';
// Canais de transmissão: um por servidor do Discord.
//
// - Só quem está liberado (CREATOR_DISCORD_IDS) pode colocar o bot num servidor,
//   e com isso vira o dono do canal.
// - Só o dono convida (link de convite) e remove membros.
// - Cada canal tem a sua sala no LiveKit, os seus clipes e os seus avisos no Discord.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { requireUser } from './auth.js';
import { sql, transaction } from './db.js';

/** Funções do bot do Discord (preenchidas por bot.js quando ele liga). */
export const discordBridge = {
  /** (guildId) => [{ id, name }] canais de texto onde o bot pode escrever */
  listTextChannels: null,
  /** (guildId) => Promise — tira o bot do servidor */
  leaveGuild: null,
};

const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('base64url');

// ---------------- usuários ----------------

export function upsertUser({ id, username, name, avatar }) {
  transaction(() => {
    // O @ pode ter mudado de dono no Discord: libera pra quem tem agora
    if (username) sql('UPDATE users SET username = NULL WHERE username = ? AND id <> ?').run(username, id);
    sql(`INSERT INTO users (id, username, name, avatar, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name,
           avatar = excluded.avatar, updated_at = excluded.updated_at`).run(id, username || null, name, avatar || '', Date.now());
  });
}

export const getUser = (id) => sql('SELECT id, username, name, avatar FROM users WHERE id = ?').get(id);
export const getUserByUsername = (username) =>
  sql('SELECT id, username, name, avatar FROM users WHERE username = ?').get(username);

export function canCreateChannels(user) {
  if (!user || !user.id.startsWith('d')) return false;
  return config.discord.creatorIds.includes(user.id.slice(1));
}

// ---------------- canais ----------------

export const roomName = (channel) => `ch-${channel.id}`;
export const channelIdFromRoom = (room) => (room?.startsWith('ch-') ? room.slice(3) : null);

const CHANNEL_COLUMNS = 'id, guild_id, name, icon, owner_id, notify_channel_id, clips_channel_id, created_at';
export const getChannel = (id) => sql(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`).get(id);
export const getChannelByGuild = (guildId) => sql(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE guild_id = ?`).get(guildId);
export const allChannels = () => sql(`SELECT ${CHANNEL_COLUMNS} FROM channels`).all();

export function createChannel({ guildId, name, icon, ownerId, notifyChannelId = '', clipsChannelId = '' }) {
  const id = newId(5);
  transaction(() => {
    sql(`INSERT INTO channels (id, guild_id, name, icon, owner_id, notify_channel_id, clips_channel_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, guildId ?? null, name, icon || '', ownerId, notifyChannelId, clipsChannelId, Date.now());
    sql('INSERT INTO members (channel_id, user_id, role, joined_at) VALUES (?, ?, \'owner\', ?)').run(id, ownerId, Date.now());
  });
  logger.info(`[canais] Canal "${name}" criado (${id}), dono ${ownerId}`);
  return getChannel(id);
}

export function updateGuildInfo(guildId, { name, icon }) {
  sql('UPDATE channels SET name = ?, icon = ? WHERE guild_id = ?').run(name, icon || '', guildId);
}

export function memberRole(channelId, userId) {
  return sql('SELECT role FROM members WHERE channel_id = ? AND user_id = ?').get(channelId, userId)?.role || null;
}

export function addMember(channelId, userId, role = 'member') {
  sql('INSERT OR IGNORE INTO members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(channelId, userId, role, Date.now());
}

/** Canal público do modo convidado (sem Discord): todo mundo entra. */
function guestChannel() {
  let channel = sql(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE guild_id IS NULL ORDER BY created_at LIMIT 1`).get();
  if (!channel) channel = createChannel({ guildId: null, name: 'Faz o L', ownerId: 'system' });
  return channel;
}

/** Os canais do usuário, com o papel dele em cada um. */
export function channelsOf(user) {
  if (config.authMode === 'guest') addMember(guestChannel().id, user.id);
  return sql(`SELECT c.id, c.name, c.icon, c.guild_id, m.role FROM members m JOIN channels c ON c.id = m.channel_id
              WHERE m.user_id = ? ORDER BY m.joined_at`).all(user.id);
}

/** Middleware para rotas /api/c/:cid/...: exige ser membro; põe req.channel e req.role. */
export function requireMember(req, res, next) {
  const channel = getChannel(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Canal não encontrado.' });
  if (config.authMode === 'guest' && !channel.guild_id) addMember(channel.id, req.user.id);
  const role = memberRole(channel.id, req.user.id);
  if (!role) return res.status(403).json({ error: 'Você não é membro deste canal. Peça um convite pro dono.' });
  req.channel = channel;
  req.role = role;
  next();
}

export function requireOwner(req, res, next) {
  if (req.role !== 'owner') return res.status(403).json({ error: 'Só o dono do canal pode fazer isso.' });
  next();
}

// ---------------- migração da versão de canal único ----------------

/**
 * Antes existia uma sala só ("faz-o-l") ligada ao DISCORD_GUILD_ID do .env.
 * Ela vira o primeiro canal: dono = primeiro liberado em CREATOR_DISCORD_IDS,
 * membros = quem já apareceu nos clipes. Os clipes antigos vêm junto.
 */
export function migrateLegacy() {
  const { guildId, creatorIds, notifyChannelId, clipsChannelId } = config.discord;
  if (config.authMode !== 'discord' || !guildId || getChannelByGuild(guildId)) return;
  if (!creatorIds.length) {
    logger.warn('[canais] Defina CREATOR_DISCORD_IDS no .env para migrar o canal antigo.');
    return;
  }
  const channel = createChannel({
    guildId,
    name: 'Faz o L',
    ownerId: `d${creatorIds[0]}`,
    notifyChannelId,
    clipsChannelId,
  });

  const legacyFile = path.join(process.env.CLIPS_DIR || '/data/clips', 'clips.json');
  let old = [];
  try {
    old = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch {
    /* sem clipes antigos */
  }
  transaction(() => {
    for (const c of old) {
      const streamerId = String(c.streamerIdentity || '').replace(/:tela$/, '');
      sql(`INSERT OR IGNORE INTO clips (id, channel_id, file, mime, size, duration, seconds, streamer_id, streamer_name,
             creator_id, creator_name, saved, published, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(c.id, channel.id, c.file, c.mime, c.size || 0, c.duration || 0, c.seconds, streamerId, c.streamerName,
          c.creatorId, c.creatorName, c.saved ? 1 : 0, c.createdAt);
      for (const uid of [streamerId, c.creatorId]) if (uid?.startsWith('d')) addMember(channel.id, uid);
    }
  });
  if (old.length) fs.renameSync(legacyFile, `${legacyFile}.migrado`);
  logger.info(`[canais] Canal antigo migrado (${old.length} clipe(s)).`);
}

// ---------------- convites ----------------

function inviteInfo(code) {
  const invite = sql('SELECT * FROM invites WHERE code = ?').get(code);
  if (!invite) return null;
  const expired = invite.expires_at && invite.expires_at < Date.now();
  const used = invite.max_uses && invite.uses >= invite.max_uses;
  return { invite, valid: !expired && !used };
}

const publicInvite = (i) => ({
  code: i.code,
  url: `${config.publicUrl}/convite/${i.code}`,
  createdAt: i.created_at,
  expiresAt: i.expires_at,
  maxUses: i.max_uses,
  uses: i.uses,
});

export function createInvite(channelId, userId, { days = 7, maxUses = null } = {}) {
  const code = newId(6);
  const expiresAt = days ? Date.now() + days * 86400000 : null;
  sql('INSERT INTO invites (code, channel_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, channelId, userId, Date.now(), expiresAt, maxUses);
  return publicInvite(sql('SELECT * FROM invites WHERE code = ?').get(code));
}

// ---------------- rotas ----------------

/** Hook pra quando alguém é removido (tira da sala do LiveKit). */
export const channelHooks = { onMemberRemoved: null };

export function channelsRouter() {
  const router = express.Router();

  router.get('/api/channels', requireUser, (req, res) => {
    res.json({ channels: channelsOf(req.user), canCreate: canCreateChannels(req.user) });
  });

  router.get('/api/c/:cid', requireUser, requireMember, (req, res) => {
    const c = req.channel;
    res.json({
      id: c.id,
      name: c.name,
      icon: c.icon,
      role: req.role,
      discord: !!c.guild_id,
      limits: { maxStreamers: config.maxStreamers, maxViewers: config.maxViewers },
    });
  });

  // Membros (pra lista do dono e pro autocompletar do @ nos clipes)
  router.get('/api/c/:cid/members', requireUser, requireMember, (req, res) => {
    const members = sql(`SELECT m.user_id AS id, m.role, u.username, COALESCE(u.name, m.user_id) AS name, COALESCE(u.avatar, '') AS avatar
                         FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY m.role DESC, name`)
      .all(req.channel.id);
    res.json({ members });
  });

  // Remove alguém (dono) ou sai do canal (o próprio membro)
  router.delete('/api/c/:cid/members/:uid', requireUser, requireMember, (req, res) => {
    const uid = req.params.uid;
    const self = uid === req.user.id;
    if (!self && req.role !== 'owner') return res.status(403).json({ error: 'Só o dono do canal pode remover membros.' });
    if (memberRole(req.channel.id, uid) === 'owner') return res.status(400).json({ error: 'O dono não pode sair do próprio canal.' });
    sql('DELETE FROM members WHERE channel_id = ? AND user_id = ?').run(req.channel.id, uid);
    channelHooks.onMemberRemoved?.(req.channel, uid);
    res.json({ ok: true });
  });

  // Convites (só o dono)
  router.get('/api/c/:cid/invites', requireUser, requireMember, requireOwner, (req, res) => {
    const list = sql('SELECT * FROM invites WHERE channel_id = ? ORDER BY created_at DESC').all(req.channel.id);
    res.json({ invites: list.filter((i) => inviteInfo(i.code).valid).map(publicInvite) });
  });

  router.post('/api/c/:cid/invites', requireUser, requireMember, requireOwner, express.json(), (req, res) => {
    const days = [1, 7, 30, 0].includes(Number(req.body?.days)) ? Number(req.body.days) : 7;
    const maxUses = [1, 5, 10, 25].includes(Number(req.body?.maxUses)) ? Number(req.body.maxUses) : null;
    res.json(createInvite(req.channel.id, req.user.id, { days, maxUses }));
  });

  router.delete('/api/c/:cid/invites/:code', requireUser, requireMember, requireOwner, (req, res) => {
    sql('DELETE FROM invites WHERE code = ? AND channel_id = ?').run(req.params.code, req.channel.id);
    res.json({ ok: true });
  });

  // Canais de texto do Discord para avisos e clipes (só o dono)
  router.get('/api/c/:cid/discord', requireUser, requireMember, requireOwner, async (req, res) => {
    const c = req.channel;
    const textChannels = c.guild_id && discordBridge.listTextChannels ? await discordBridge.listTextChannels(c.guild_id) : [];
    res.json({ textChannels, notifyChannelId: c.notify_channel_id, clipsChannelId: c.clips_channel_id });
  });

  router.put('/api/c/:cid/discord', requireUser, requireMember, requireOwner, express.json(), (req, res) => {
    const clean = (v) => (/^\d{5,25}$/.test(String(v || '')) ? String(v) : '');
    sql('UPDATE channels SET notify_channel_id = ?, clips_channel_id = ? WHERE id = ?')
      .run(clean(req.body?.notifyChannelId), clean(req.body?.clipsChannelId), req.channel.id);
    res.json({ ok: true });
  });

  // Convite: dá pra ver o nome do canal antes de entrar (sem login)
  router.get('/api/invites/:code', (req, res) => {
    const info = inviteInfo(req.params.code);
    if (!info) return res.status(404).json({ error: 'Convite não encontrado.' });
    const channel = getChannel(info.invite.channel_id);
    res.json({
      valid: info.valid,
      channel: { id: channel.id, name: channel.name, icon: channel.icon },
      member: !!req.user && !!memberRole(channel.id, req.user.id),
    });
  });

  router.post('/api/invites/:code/accept', requireUser, (req, res) => {
    const info = inviteInfo(req.params.code);
    if (!info?.valid) return res.status(410).json({ error: 'Esse convite expirou ou já foi usado.' });
    const channelId = info.invite.channel_id;
    if (!memberRole(channelId, req.user.id)) {
      transaction(() => {
        addMember(channelId, req.user.id);
        sql('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(info.invite.code);
      });
    }
    res.json({ channelId });
  });

  return router;
}
