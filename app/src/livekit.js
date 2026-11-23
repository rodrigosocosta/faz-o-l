import { EventEmitter } from 'node:events';
import express from 'express';
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import { config } from './config.js';
import { requireUser } from './auth.js';
import { channelHooks, channelIdFromRoom, getChannel, requireMember, roomName } from './channels.js';

const { host, apiKey, apiSecret } = config.livekit;
const roomService = new RoomServiceClient(host, apiKey, apiSecret);
const webhookReceiver = new WebhookReceiver(apiKey, apiSecret);

/**
 * Eventos emitidos para o bot do Discord (todos com o canal):
 *  - 'stream:start' { channel, identity, name }
 *  - 'stream:end'   { channel, identity, name }
 *  - 'room:update'  { channel }
 *  - 'clip:published' { channel, clip }   (emitido por clips.js)
 */
export const liveEvents = new EventEmitter();

// Chave dos mapas abaixo: "<sala>|<identidade>"
const key = (room, identity) => `${room}|${identity}`;

// Quem está transmitindo agora (preenchido pelos webhooks do LiveKit)
const activeStreams = new Map(); // chave -> nome
// Quem recebeu vaga e ainda não publicou a tela (para liberar vagas "presas")
const pendingGrants = new Map(); // chave -> timestamp
// Tokens do app desktop já emitidos, mas cujo participante ainda não entrou na sala
const pendingDesktop = new Map(); // chave -> timestamp
const PENDING_TIMEOUT_MS = 20_000;

const VIEWER_PERMISSION = {
  canSubscribe: true,
  canPublish: false,
  canPublishData: true,
  canPublishSources: [],
};

const STREAMER_PERMISSION = {
  canSubscribe: true,
  canPublish: true,
  canPublishData: true,
  canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
};

// Mutex por sala: evita que 2 pessoas peguem a última vaga ao mesmo tempo
const locks = new Map();
function withLock(room, fn) {
  const run = (locks.get(room) || Promise.resolve()).then(fn, fn);
  locks.set(room, run.catch(() => {}));
  return run;
}

// O gravador de clipes entra nas salas escondido: não conta como pessoa
export const RECORDER_IDENTITY = 'fazol-recorder';

async function listParticipants(room) {
  try {
    const all = await roomService.listParticipants(room);
    return all.filter((p) => p.identity !== RECORDER_IDENTITY);
  } catch {
    return []; // sala ainda não existe
  }
}

function isScreenTrack(track) {
  return track?.source === TrackSource.SCREEN_SHARE;
}

function hasScreenShare(p) {
  return (p.tracks || []).some(isScreenTrack);
}

async function setPermission(room, identity, permission) {
  await roomService.updateParticipant(room, identity, undefined, permission);
}

// O app desktop transmite como um participante separado: "<id do usuário>:tela"
const DESKTOP_SUFFIX = ':tela';
const isDesktop = (identity) => identity.endsWith(DESKTOP_SUFFIX);
// A página dentro do app desktop entra como "<id>:app" (assim a mesma pessoa pode
// transmitir pelo app e assistir no navegador ao mesmo tempo)
const APP_SUFFIX = ':app';
export const ownerOf = (identity) => identity.replace(/:(tela|app)$/, '');

// Nome de quem pegou token (o webhook do LiveKit às vezes chega sem o nome)
const knownNames = new Map(); // id do usuário -> nome
function rememberName(identity, name) {
  if (name) knownNames.set(ownerOf(identity), name);
}
/** Nome pra mostrar: nunca o id cru nem o sufixo ":tela" do app desktop. */
export function displayName(identity, name) {
  if (name && name !== identity) return name;
  return knownNames.get(ownerOf(identity)) || ownerOf(identity);
}

/** Quem ocupa vaga de transmissão: publicando, com permissão, ou desktop prestes a entrar. */
function streamerIdentities(room, participants) {
  const ids = new Set(
    participants.filter((p) => p.permission?.canPublish || hasScreenShare(p)).map((p) => p.identity),
  );
  const now = Date.now();
  for (const [k, since] of pendingDesktop) {
    if (now - since > PENDING_TIMEOUT_MS) pendingDesktop.delete(k);
    else if (k.startsWith(`${room}|`)) ids.add(k.slice(room.length + 1));
  }
  return ids;
}

/** Retorna o erro 409 se as vagas de transmissão acabaram, ou null. */
function slotsFull(room, participants) {
  const ids = streamerIdentities(room, participants);
  if (ids.size < config.maxStreamers) return null;
  const names = [...ids]
    .map((id) => displayName(id, participants.find((p) => p.identity === id)?.name) || 'alguém')
    .join(' e ');
  return { status: 409, error: `Já tem ${config.maxStreamers} pessoas transmitindo (${names}). Espere uma vaga.` };
}

async function removeParticipant(room, identity) {
  await roomService.removeParticipant(room, identity).catch(() => {});
}

async function ensureRoom(room) {
  await roomService.createRoom({ name: room, emptyTimeout: 300, maxParticipants: config.maxViewers + config.maxStreamers });
}

/** Estado atual da sala de um canal (usado pela API, pelos clipes e pelo bot). */
export async function getRoomState(channel) {
  const participants = await listParticipants(roomName(channel));
  const streamers = participants
    .filter((p) => p.permission?.canPublish || hasScreenShare(p))
    .map((p) => ({ identity: p.identity, name: displayName(p.identity, p.name), live: hasScreenShare(p) }));
  return {
    streamers,
    viewers: participants.length - streamers.length,
    total: participants.length,
    maxStreamers: config.maxStreamers,
    maxViewers: config.maxViewers,
  };
}

function emitUpdate(room) {
  const channel = getChannel(channelIdFromRoom(room));
  if (channel) liveEvents.emit('room:update', { channel });
}

/** Libera vagas de quem pediu pra transmitir mas nunca publicou a tela. */
async function sweepStuckGrants() {
  const rooms = new Set([...pendingGrants.keys()].map((k) => k.split('|')[0]));
  const now = Date.now();
  for (const room of rooms) {
    for (const p of await listParticipants(room)) {
      const k = key(room, p.identity);
      if (!p.permission?.canPublish) continue;
      if (hasScreenShare(p)) {
        pendingGrants.delete(k);
        continue;
      }
      const since = pendingGrants.get(k) ?? 0;
      if (now - since > PENDING_TIMEOUT_MS) {
        pendingGrants.delete(k);
        if (isDesktop(p.identity)) await removeParticipant(room, p.identity);
        else await setPermission(room, p.identity, VIEWER_PERMISSION).catch(() => {});
        emitUpdate(room);
      }
    }
  }
}
setInterval(() => sweepStuckGrants().catch(() => {}), 10_000).unref();

function endStream(room, identity) {
  const k = key(room, identity);
  const name = activeStreams.get(k);
  if (name === undefined) return;
  activeStreams.delete(k);
  const channel = getChannel(channelIdFromRoom(room));
  if (channel) liveEvents.emit('stream:end', { channel, identity, name });
}

// Membro removido do canal: sai da sala na hora (navegador e app desktop)
channelHooks.onMemberRemoved = (channel, userId) => {
  const room = roomName(channel);
  removeParticipant(room, userId);
  removeParticipant(room, `${userId}${DESKTOP_SUFFIX}`);
  removeParticipant(room, `${userId}${APP_SUFFIX}`);
};

export function livekitRouter() {
  const router = express.Router();

  // Webhooks do LiveKit (corpo cru é necessário para validar a assinatura)
  router.post('/api/livekit/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    let event;
    try {
      event = await webhookReceiver.receive(req.body.toString('utf8'), req.get('Authorization'));
    } catch {
      return res.status(401).end();
    }
    res.status(200).end();

    const room = event.room?.name;
    const channel = getChannel(channelIdFromRoom(room));
    if (!channel) return;
    const p = event.participant;

    switch (event.event) {
      case 'track_published':
        if (p && isScreenTrack(event.track) && !activeStreams.has(key(room, p.identity))) {
          pendingGrants.delete(key(room, p.identity));
          pendingDesktop.delete(key(room, p.identity));
          const name = displayName(p.identity, p.name);
          activeStreams.set(key(room, p.identity), name);
          liveEvents.emit('stream:start', { channel, identity: p.identity, name });
        }
        break;
      case 'track_unpublished':
        if (p && isScreenTrack(event.track)) {
          endStream(room, p.identity);
          // Parou de transmitir: devolve a vaga (o participante do app desktop sai da sala)
          if (isDesktop(p.identity)) removeParticipant(room, p.identity);
          else setPermission(room, p.identity, VIEWER_PERMISSION).catch(() => {});
        }
        break;
      case 'participant_left':
        if (p) {
          pendingGrants.delete(key(room, p.identity));
          pendingDesktop.delete(key(room, p.identity));
          endStream(room, p.identity);
        }
        break;
      case 'room_finished':
        for (const k of [...activeStreams.keys()]) if (k.startsWith(`${room}|`)) endStream(room, k.slice(room.length + 1));
        for (const k of [...pendingGrants.keys()]) if (k.startsWith(`${room}|`)) pendingGrants.delete(k);
        break;
    }
    liveEvents.emit('room:update', { channel });
  });

  const member = [requireUser, requireMember];

  router.get('/api/c/:cid/status', ...member, async (req, res) => {
    res.json(await getRoomState(req.channel));
  });

  // Token para entrar na sala (todo mundo entra como espectador)
  router.post('/api/c/:cid/token', ...member, express.json(), async (req, res) => {
    const user = req.user;
    const identity = req.body?.client === 'desktop' ? `${user.id}${APP_SUFFIX}` : user.id;
    const room = roomName(req.channel);
    const participants = await listParticipants(room);
    const others = participants.filter((p) => p.identity !== identity);
    const capacity = config.maxViewers + config.maxStreamers;
    if (others.length >= capacity) {
      return res.status(409).json({ error: `Sala cheia (${capacity} pessoas). Tente daqui a pouco.` });
    }

    try {
      await ensureRoom(room);
    } catch (err) {
      console.error('[livekit] Não consegui criar/verificar a sala:', err.message);
      return res.status(503).json({ error: 'Servidor de vídeo indisponível. Tente novamente.' });
    }

    rememberName(user.id, user.name);
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: user.name,
      metadata: JSON.stringify({ avatar: user.avatar || '', username: user.username || '' }),
      ttl: '12h',
    });
    at.addGrant({
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: false,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });

    res.json({ token: await at.toJwt(), url: config.livekit.publicUrl || null });
  });

  // Pede uma vaga para transmitir
  router.post('/api/c/:cid/stream/start', ...member, async (req, res) => {
    const identity = req.user.id;
    const room = roomName(req.channel);
    try {
      const result = await withLock(room, async () => {
        const participants = await listParticipants(room);
        const me = participants.find((p) => p.identity === identity);
        if (!me) return { status: 409, error: 'Entre na sala antes de transmitir.' };
        if (me.permission?.canPublish) return { status: 200 };
        if (streamerIdentities(room, participants).has(`${identity}${DESKTOP_SUFFIX}`)) {
          return { status: 409, error: 'Você já está transmitindo pelo app desktop.' };
        }

        const full = slotsFull(room, participants);
        if (full) return full;

        pendingGrants.set(key(room, identity), Date.now());
        await setPermission(room, identity, STREAMER_PERMISSION);
        return { status: 200 };
      });
      if (result.status !== 200) return res.status(result.status).json({ error: result.error });
      emitUpdate(room);
      res.json({ ok: true });
    } catch (err) {
      console.error('[livekit] stream/start:', err.message);
      res.status(500).json({ error: 'Não foi possível liberar a transmissão.' });
    }
  });

  // App desktop: token próprio de transmissão (participante "<id>:tela", só publica a tela)
  router.post('/api/c/:cid/desktop/token', ...member, async (req, res) => {
    const user = req.user;
    const room = roomName(req.channel);
    const identity = `${user.id}${DESKTOP_SUFFIX}`;
    try {
      const result = await withLock(room, async () => {
        const participants = await listParticipants(room);
        const ids = streamerIdentities(room, participants);
        if (ids.has(user.id)) return { status: 409, error: 'Você já está transmitindo pelo navegador.' };
        if (!ids.has(identity)) {
          const full = slotsFull(room, participants);
          if (full) return full;
        }
        pendingDesktop.set(key(room, identity), Date.now());
        return { status: 200 };
      });
      if (result.status !== 200) return res.status(result.status).json({ error: result.error });

      await ensureRoom(room);
      rememberName(user.id, user.name);
      const at = new AccessToken(apiKey, apiSecret, {
        identity,
        name: user.name,
        metadata: JSON.stringify({ avatar: user.avatar || '', username: user.username || '', desktop: true, owner: user.id }),
        ttl: '12h',
      });
      at.addGrant({
        roomJoin: true,
        room,
        canSubscribe: false, // só envia: não gasta banda recebendo as outras lives
        canPublish: true,
        canPublishData: false,
        // UNKNOWN = trilha "voices" (vozes do Discord, separadas do som da live; só vão pro clipe)
        canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.UNKNOWN],
        canUpdateOwnMetadata: false,
      });
      emitUpdate(room);
      res.json({
        token: await at.toJwt(),
        url: config.livekit.publicUrl || config.publicUrl.replace(/^http/, 'ws'),
        identity,
      });
    } catch (err) {
      console.error('[livekit] desktop/token:', err.message);
      res.status(500).json({ error: 'Não foi possível liberar a transmissão.' });
    }
  });

  // Encerra a transmissão do app desktop (tira o participante "<id>:tela" da sala)
  router.post('/api/c/:cid/desktop/stop', ...member, async (req, res) => {
    const room = roomName(req.channel);
    const identity = `${req.user.id}${DESKTOP_SUFFIX}`;
    pendingDesktop.delete(key(room, identity));
    await removeParticipant(room, identity);
    emitUpdate(room);
    res.json({ ok: true });
  });

  // Encerra a transmissão e devolve a vaga
  router.post('/api/c/:cid/stream/stop', ...member, async (req, res) => {
    const room = roomName(req.channel);
    pendingGrants.delete(key(room, req.user.id));
    await setPermission(room, req.user.id, VIEWER_PERMISSION).catch(() => {});
    emitUpdate(room);
    res.json({ ok: true });
  });

  return router;
}
