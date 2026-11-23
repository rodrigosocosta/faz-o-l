// Eventos: assistir um vídeo ou live do YouTube (ou da Twitch) juntos, todo mundo no mesmo ponto.
//
// Ninguém transmite a tela: cada pessoa toca o vídeo direto do YouTube, e o servidor
// guarda só "qual vídeo, em que segundo, tocando ou pausado, desde quando". Toda
// mudança vai para quem está na sala pelos metadados da sala do LiveKit; cada player
// calcula onde deveria estar e se ajusta sozinho se escapar mais de ~1,5 s.

import express from 'express';
import { RoomServiceClient } from 'livekit-server-sdk';
import { config } from './config.js';
import { requireUser } from './auth.js';
import { memberRole, requireMember, roomName } from './channels.js';
import { liveEvents } from './livekit.js';
import { db, sql } from './db.js';

const { host, apiKey, apiSecret } = config.livekit;
const roomService = new RoomServiceClient(host, apiKey, apiSecret);

const events = new Map(); // id do canal -> evento

// Guardado no banco: reiniciar/atualizar o servidor não derruba o evento
db.exec('CREATE TABLE IF NOT EXISTS events (channel_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
for (const row of sql('SELECT channel_id, data FROM events').all()) {
  try {
    events.set(row.channel_id, JSON.parse(row.data));
  } catch {}
}
function saveEvent(channelId) {
  const ev = events.get(channelId);
  if (ev) sql('INSERT OR REPLACE INTO events (channel_id, data) VALUES (?, ?)').run(channelId, JSON.stringify(ev));
  else sql('DELETE FROM events WHERE channel_id = ?').run(channelId);
}

/** Aceita link do YouTube (watch, youtu.be, shorts, live, embed) ou o id do vídeo. */
export function youtubeId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1];
  }
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}

const TWITCH_RESERVED = new Set(['directory', 'search', 'settings', 'p', 'downloads', 'jobs', 'turbo', 'videos', 'login', 'signup', 'subscriptions', 'inventory', 'wallet', 'drops']);

/** Link da Twitch: canal (live) ou vídeo gravado (VOD). */
export function twitchMedia(input) {
  const text = String(input || '').trim();
  let url;
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  if (host === 'player.twitch.tv') {
    const channel = url.searchParams.get('channel');
    const video = url.searchParams.get('video')?.replace(/^v/, '');
    if (video && /^\d{5,15}$/.test(video)) return { kind: 'video', id: video };
    if (channel && /^\w{3,25}$/.test(channel)) return { kind: 'channel', id: channel.toLowerCase() };
    return null;
  }
  if (host !== 'twitch.tv') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'videos' && /^\d{5,15}$/.test(parts[1] || '')) return { kind: 'video', id: parts[1] };
  if (parts[1] === 'video' && /^\d{5,15}$/.test(parts[2] || '')) return { kind: 'video', id: parts[2] };
  if (parts[0] && /^\w{3,25}$/.test(parts[0]) && !TWITCH_RESERVED.has(parts[0].toLowerCase())) {
    return { kind: 'channel', id: parts[0].toLowerCase() };
  }
  return null;
}

/** Segundo em que o vídeo deve estar agora. */
const currentPosition = (ev, now = Date.now()) => ev.position + (ev.playing ? (now - ev.updatedAt) / 1000 : 0);

function publicEvent(ev) {
  return ev ? { ...ev, position: currentPosition(ev), updatedAt: Date.now() } : null;
}

async function videoTitle(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return { title: String(data.title || '').slice(0, 200), author: String(data.author_name || '').slice(0, 100) };
  } catch {
    return null;
  }
}

/** Avisa quem está na sala (metadados da sala; se ninguém estiver nela, não tem a quem avisar). */
async function broadcast(channel) {
  saveEvent(channel.id);
  const payload = JSON.stringify({ event: publicEvent(events.get(channel.id)) });
  await roomService.updateRoomMetadata(roomName(channel), payload).catch(() => {});
}

const canControl = (ev, user, channel) => ev.by.id === user.id || memberRole(channel.id, user.id) === 'owner';

export function eventsRouter() {
  const router = express.Router();
  const member = [requireUser, requireMember];

  router.get('/api/c/:cid/event', ...member, (req, res) => {
    res.json({ event: publicEvent(events.get(req.channel.id)), now: Date.now() });
  });

  // Começa (ou troca) o evento
  router.post('/api/c/:cid/event', ...member, express.json(), async (req, res) => {
    const channel = req.channel;
    const current = events.get(channel.id);
    if (current && !canControl(current, req.user, channel)) {
      return res.status(403).json({ error: `Já tem um evento rolando (de ${current.by.name}). Só quem começou ou o dono do canal pode trocar.` });
    }
    const videoId = youtubeId(req.body?.url);
    const twitch = videoId ? null : twitchMedia(req.body?.url);
    if (!videoId && !twitch) return res.status(400).json({ error: 'Cole um link do YouTube (vídeo ou live) ou da Twitch (canal ou vídeo).' });
    const info = videoId ? await videoTitle(videoId) : null;
    const fallback = twitch
      ? (twitch.kind === 'channel' ? `Live de ${twitch.id} na Twitch` : 'Vídeo da Twitch')
      : 'Evento';
    const title = String(req.body?.title || '').trim().slice(0, 100) || info?.title || fallback;
    const ev = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      source: twitch ? 'twitch' : 'youtube',
      ...(twitch ? { twitch } : { videoId }),
      title,
      author: info?.author || (twitch?.kind === 'channel' ? twitch.id : ''),
      by: { id: req.user.id, name: req.user.name },
      playing: true,
      position: Math.max(0, Number(req.body?.start) || 0),
      updatedAt: Date.now(),
    };
    events.set(channel.id, ev);
    await broadcast(channel);
    if (!current) liveEvents.emit('event:start', { channel, event: ev });
    res.json({ event: publicEvent(ev), now: Date.now() });
  });

  // Tocar, pausar ou pular para um ponto
  router.patch('/api/c/:cid/event', ...member, express.json(), async (req, res) => {
    const channel = req.channel;
    const ev = events.get(channel.id);
    if (!ev) return res.status(404).json({ error: 'Nenhum evento rolando.' });
    if (!canControl(ev, req.user, channel)) return res.status(403).json({ error: 'Só quem começou o evento ou o dono do canal controla.' });
    const now = Date.now();
    const action = req.body?.action;
    const position = Number(req.body?.position);
    ev.position = Number.isFinite(position) && position >= 0 ? position : currentPosition(ev, now);
    if (action === 'pause') ev.playing = false;
    else if (action === 'play') ev.playing = true;
    else if (action !== 'seek') return res.status(400).json({ error: 'Ação inválida.' });
    // Live do YouTube: a posição passa a ser o "tempo da live" do player de quem controla
    // (o mesmo para todo mundo), em vez de segundos desde o começo do evento.
    if (req.body?.live === true) ev.live = true;
    ev.updatedAt = now;
    await broadcast(channel);
    res.json({ event: publicEvent(ev), now });
  });

  // Encerra o evento
  router.delete('/api/c/:cid/event', ...member, async (req, res) => {
    const channel = req.channel;
    const ev = events.get(channel.id);
    if (!ev) return res.json({ ok: true });
    if (!canControl(ev, req.user, channel)) return res.status(403).json({ error: 'Só quem começou o evento ou o dono do canal pode encerrar.' });
    events.delete(channel.id);
    await broadcast(channel);
    liveEvents.emit('event:end', { channel, event: ev });
    res.json({ ok: true });
  });

  return router;
}
