import { logger } from './logger.js';
// Clipes: os últimos 30 s / 1 min / 2 min de uma live, gerados pelo serviço "recorder".
//
// O recorder fica gravando cada live em pedaços de ~4 s (sem recodificar) e, quando
// alguém clipa, junta os pedaços num MP4/WebM dentro do volume compartilhado.
// Aqui ficam os metadados (título, descrição, marcações @), permissões, perfis e a
// limpeza: clipe não salvo some em 24 h.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { requireUser } from './auth.js';
import { getChannel, getUserByUsername, memberRole, requireMember, roomName } from './channels.js';
import { sql, transaction } from './db.js';
import { getRoomState, liveEvents, ownerOf } from './livekit.js';

const CLIPS_DIR = process.env.CLIPS_DIR || '/data/clips';
const RECORDER_URL = process.env.RECORDER_URL || 'http://recorder:8090';
const UNSAVED_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLISH_FALLBACK_MS = 3 * 60 * 1000; // sem título em 3 min: posta no Discord assim mesmo
// Duração do clipe: qualquer valor de 5 s a 3 min (configurável por quem clipa)
const MIN_SECONDS = 5;
const MAX_SECONDS = 180;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 500;

// @ do Discord: letras, números, "_" e "." (2 a 32)
const MENTION_RE = /@([a-z0-9_.]{2,32})/gi;

const getClip = (id) => sql('SELECT * FROM clips WHERE id = ?').get(id);

const nameKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_.]/gi, '').toLowerCase();

/**
 * Usuários marcados que são membros do canal do clipe. Aceita o @ do Discord
 * (@dougrinhas) ou o nome de exibição sem espaços (@douglas), se for único no
 * canal; nesse caso o texto é reescrito para o @ do Discord.
 */
function resolveMentions(channelId, ...texts) {
  const members = sql(`SELECT u.id, u.username, u.name, u.avatar FROM members m JOIN users u ON u.id = m.user_id
                       WHERE m.channel_id = ? AND u.username IS NOT NULL`).all(channelId);
  const byName = new Map();
  for (const u of members) {
    const key = nameKey(u.name);
    if (key.length >= 2) byName.set(key, byName.has(key) ? null : u);
  }
  const found = new Map();
  const rewritten = texts.map((text) =>
    String(text || '').replace(MENTION_RE, (whole, raw) => {
      const token = raw.replace(/\.+$/, '');
      const key = token.toLowerCase();
      let user = getUserByUsername(key);
      if (!user || !memberRole(channelId, user.id)) user = byName.get(key) || null;
      if (!user) return whole;
      found.set(user.id, user);
      return `@${user.username}${raw.slice(token.length)}`;
    }),
  );
  return { users: [...found.values()], texts: rewritten };
}

const mentionsOf = (clipId) =>
  sql(`SELECT u.id, u.username, u.name, u.avatar FROM clip_mentions m JOIN users u ON u.id = m.user_id WHERE m.clip_id = ?`).all(clipId);

function usernameOf(userId) {
  return sql('SELECT username FROM users WHERE id = ?').get(userId)?.username || null;
}

function publicClip(clip, user, channel = null) {
  const ch = channel || getChannel(clip.channel_id);
  const owner = !!user && ch && memberRole(ch.id, user.id) === 'owner';
  return {
    id: clip.id,
    url: `/clips/${clip.file}`,
    page: `/clip/${clip.id}`,
    mime: clip.mime,
    size: clip.size,
    seconds: clip.seconds,
    duration: clip.duration,
    title: clip.title,
    description: clip.description,
    streamer: { id: clip.streamer_id, name: clip.streamer_name, username: usernameOf(clip.streamer_id) },
    creator: { id: clip.creator_id, name: clip.creator_name, username: usernameOf(clip.creator_id) },
    mentions: mentionsOf(clip.id),
    channel: ch ? { id: ch.id, name: ch.name } : null,
    createdAt: clip.created_at,
    saved: !!clip.saved,
    expiresAt: clip.saved ? null : clip.created_at + UNSAVED_TTL_MS,
    savedBy: clip.saved && clip.saved_by ? nameOf(clip.saved_by) : null,
    mine: !!user && clip.creator_id === user.id,
    canSave: !!user && !!ch && !!memberRole(ch.id, user.id),
    canUnsave: !!user && canUnsave(clip, user.id),
    canDelete: !!user && (clip.creator_id === user.id || owner),
  };
}

function nameOf(userId) {
  return sql('SELECT name FROM users WHERE id = ?').get(userId)?.name || null;
}

/** Tirar dos salvos: quem salvou, quem clipou ou o dono do canal. */
function canUnsave(clip, userId) {
  return clip.saved_by === userId || clip.creator_id === userId
    || memberRole(clip.channel_id, userId) === 'owner';
}

/** Salvar: qualquer membro do canal. Desfazer: ver canUnsave. Devolve a mensagem de erro, se houver. */
function setSaved(clip, userId, saved) {
  if (!memberRole(clip.channel_id, userId)) return 'Só quem participa do canal pode salvar.';
  if (saved) {
    if (!clip.saved) sql('UPDATE clips SET saved = 1, saved_by = ? WHERE id = ?').run(userId, clip.id);
    return null;
  }
  if (!clip.saved) return null;
  if (!canUnsave(clip, userId)) return 'Só quem salvou, quem clipou ou o dono do canal pode tirar dos salvos.';
  sql('UPDATE clips SET saved = 0, saved_by = NULL WHERE id = ?').run(clip.id);
  return null;
}

async function removeClip(clip) {
  await fs.rm(path.join(CLIPS_DIR, clip.file), { force: true });
  sql('DELETE FROM clips WHERE id = ?').run(clip.id);
}

async function cleanup() {
  const expired = sql('SELECT * FROM clips WHERE saved = 0 AND created_at < ?').all(Date.now() - UNSAVED_TTL_MS);
  for (const clip of expired) await removeClip(clip);
  if (expired.length) logger.info(`[clips] ${expired.length} clipe(s) não salvo(s) apagado(s) (mais de 24 h)`);
}

/** Posta no Discord uma vez só (quando quem clipou confirma o título, ou depois de 3 min). */
function publish(clipId) {
  const res = sql('UPDATE clips SET published = 1 WHERE id = ? AND published = 0').run(clipId);
  if (!res.changes) return;
  const clip = getClip(clipId);
  const channel = getChannel(clip.channel_id);
  if (channel) liveEvents.emit('clip:published', { channel, clip: { ...clip, mentions: mentionsOf(clip.id) } });
}

function setDetails(clip, { title, description }) {
  const resolved = resolveMentions(
    clip.channel_id,
    String(title ?? clip.title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(),
    String(description ?? clip.description).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim(),
  );
  const mentioned = resolved.users;
  const cleanTitle = resolved.texts[0].slice(0, TITLE_MAX);
  const cleanDescription = resolved.texts[1].slice(0, DESCRIPTION_MAX);
  transaction(() => {
    sql('UPDATE clips SET title = ?, description = ? WHERE id = ?').run(cleanTitle, cleanDescription, clip.id);
    sql('DELETE FROM clip_mentions WHERE clip_id = ?').run(clip.id);
    for (const user of mentioned) sql('INSERT OR IGNORE INTO clip_mentions (clip_id, user_id) VALUES (?, ?)').run(clip.id, user.id);
  });
  // Já postado no Discord: atualiza o post com o título/descrição novos
  if (clip.published && (cleanTitle !== clip.title || cleanDescription !== clip.description)) {
    const channel = getChannel(clip.channel_id);
    const updated = getClip(clip.id);
    if (channel) liveEvents.emit('clip:updated', { channel, clip: { ...updated, mentions: mentionsOf(clip.id) } });
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const lengthLabel = (seconds) => {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m ? (s ? `${m} min ${s} s` : `${m} min`) : `${s} s`;
};

/** Clipes que o usuário pode ver: dos canais em que ele é membro. */
const VISIBLE = 'c.channel_id IN (SELECT channel_id FROM members WHERE user_id = ?)';

export async function clipsRouter() {
  await fs.mkdir(CLIPS_DIR, { recursive: true });
  await cleanup();
  setInterval(() => cleanup().catch((e) => logger.error('[clips] limpeza:', e)), 10 * 60 * 1000).unref();
  // Clipes que ficaram sem confirmar o título (aba fechada etc.)
  setInterval(() => {
    for (const { id } of sql('SELECT id FROM clips WHERE published = 0 AND created_at < ?').all(Date.now() - PUBLISH_FALLBACK_MS)) publish(id);
  }, 30_000).unref();

  // Live começou: o gravador entra na sala na hora (sem esperar a varredura dele)
  liveEvents.on('stream:start', ({ channel }) => {
    fetch(`${RECORDER_URL}/join?room=${encodeURIComponent(roomName(channel))}`, { method: 'POST', signal: AbortSignal.timeout(3000) })
      .catch(() => {});
  });

  const router = express.Router();
  const member = [requireUser, requireMember];

  // Arquivos dos clipes: link "não listado" (id aleatório), pra abrir direto no Discord
  router.use(
    '/clips',
    express.static(CLIPS_DIR, {
      index: false,
      dotfiles: 'deny',
      setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400'),
    }),
  );

  router.get('/api/c/:cid/clips', ...member, (req, res) => {
    const list = sql('SELECT * FROM clips WHERE channel_id = ? ORDER BY created_at DESC LIMIT 100').all(req.channel.id);
    res.json({ clips: list.map((c) => publicClip(c, req.user, req.channel)), ttlHours: UNSAVED_TTL_MS / 3600000 });
  });

  router.post('/api/c/:cid/clips', ...member, express.json(), async (req, res) => {
    const seconds = Number(req.body?.seconds);
    const requested = String(req.body?.streamer || '');
    if (!Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
      return res.status(400).json({ error: `A duração do clipe vai de ${MIN_SECONDS} s a 3 min.` });
    }

    // Aceita a identidade exata ou o id do dono (a live do app desktop é "<id>:tela")
    const state = await getRoomState(req.channel);
    const live = state.streamers.filter((s) => s.live);
    const streamer = live.find((s) => s.identity === requested) || live.find((s) => ownerOf(s.identity) === requested);
    if (!streamer) return res.status(404).json({ error: 'Essa live não está no ar.' });
    const identity = streamer.identity;

    const id = crypto.randomBytes(9).toString('base64url');
    let made;
    try {
      const r = await fetch(`${RECORDER_URL}/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomName(req.channel), identity, seconds, id }),
        signal: AbortSignal.timeout(60_000),
      });
      made = await r.json().catch(() => ({}));
      if (r.status === 409) {
        return res.status(409).json({ error: 'A live acabou de começar e ainda não tem nada gravado. Espere uns segundos e clipe de novo.' });
      }
      if (!r.ok) throw new Error(made.error || `recorder respondeu ${r.status}`);
    } catch (err) {
      logger.error('[clips] falha ao clipar:', err);
      return res.status(502).json({ error: 'Não consegui gerar o clipe. Tente de novo em alguns segundos.' });
    }

    sql(`INSERT INTO clips (id, channel_id, file, mime, size, duration, seconds, streamer_id, streamer_name,
           creator_id, creator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.channel.id, made.file, made.mime, made.size || 0, made.duration || 0, seconds,
        ownerOf(identity), streamer.name, req.user.id, req.user.name, Date.now());
    logger.event('INFO', 'Clipe gerado', {
      'event.name': 'clip.created', 'clip.duration_seconds': made.duration || 0,
      'clip.size_bytes': made.size || 0, 'streamer.id': ownerOf(identity), 'streamer.name': streamer.name,
      'creator.id': req.user.id, 'creator.name': req.user.name,
      'channel.id': req.channel.id, 'channel.name': req.channel.name,
    });
    res.json(publicClip(getClip(id), req.user, req.channel));
  });

  // Título, descrição (com @marcações) e/ou salvar. "publish": posta no Discord agora.
  router.patch('/api/clips/:id', requireUser, express.json(), (req, res) => {
    const clip = getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clipe não encontrado (talvez já tenha expirado).' });
    if (!memberRole(clip.channel_id, req.user.id)) return res.status(403).json({ error: 'Você não é membro deste canal.' });
    const body = req.body || {};
    const editing = 'title' in body || 'description' in body || body.publish;
    if (editing && clip.creator_id !== req.user.id) return res.status(403).json({ error: 'Só quem clipou pode editar.' });
    if ('saved' in body) {
      const error = setSaved(clip, req.user.id, !!body.saved);
      if (error) return res.status(403).json({ error });
    }
    if ('title' in body || 'description' in body) setDetails(clip, body);
    if (body.publish) publish(clip.id);
    res.json(publicClip(getClip(clip.id), req.user));
  });

  // Compatibilidade com a versão anterior do site
  router.post('/api/clips/:id/save', requireUser, express.json(), (req, res) => {
    const clip = getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clipe não encontrado (talvez já tenha expirado).' });
    const error = setSaved(clip, req.user.id, req.body?.saved !== false);
    if (error) return res.status(403).json({ error });
    res.json(publicClip(getClip(clip.id), req.user));
  });

  // Quem clipou ou o dono do canal pode excluir
  router.delete('/api/clips/:id', requireUser, async (req, res) => {
    const clip = getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clipe não encontrado.' });
    const owner = memberRole(clip.channel_id, req.user.id) === 'owner';
    if (clip.creator_id !== req.user.id && !owner) return res.status(403).json({ error: 'Só quem clipou ou o dono do canal pode excluir.' });
    await removeClip(clip);
    res.json({ ok: true });
  });

  // Perfil: clipes das lives da pessoa + clipes em que ela foi marcada
  // (só dos canais que quem está vendo também participa)
  router.get('/api/users/:username', requireUser, (req, res) => {
    const user = getUserByUsername(req.params.username);
    if (!user) return res.status(404).json({ error: 'Ninguém com esse @ entrou no Faz o L ainda.' });
    const viewer = req.user.id;
    const streamed = sql(`SELECT c.* FROM clips c WHERE c.streamer_id = ? AND ${VISIBLE} ORDER BY c.created_at DESC LIMIT 100`)
      .all(user.id, viewer);
    const tagged = sql(`SELECT c.* FROM clips c JOIN clip_mentions m ON m.clip_id = c.id
                        WHERE m.user_id = ? AND ${VISIBLE} ORDER BY c.created_at DESC LIMIT 100`).all(user.id, viewer);
    const shared = sql(`SELECT ch.id, ch.name, ch.icon FROM channels ch
                        JOIN members a ON a.channel_id = ch.id AND a.user_id = ?
                        JOIN members b ON b.channel_id = ch.id AND b.user_id = ?`).all(user.id, viewer);
    res.json({
      user,
      me: user.id === viewer,
      channels: shared,
      streamed: streamed.map((c) => publicClip(c, req.user)),
      tagged: tagged.map((c) => publicClip(c, req.user)),
    });
  });

  // Página do clipe, com metatags pro Discord mostrar o vídeo embutido
  router.get('/clip/:id', (req, res) => {
    const clip = getClip(req.params.id);
    if (!clip) return res.status(404).send('Clipe não encontrado (clipes não salvos expiram em 24 h).');
    const video = `${config.publicUrl}/clips/${clip.file}`;
    const fallback = `${clip.streamer_name} • clipe de ${lengthLabel(clip.seconds)}`;
    const title = clip.title || fallback;
    const byline = `${clip.title ? `Live de ${clip.streamer_name} • ` : ''}clipado por ${clip.creator_name}`;
    const description = clip.description ? `${clip.description}\n\n${byline}` : byline;
    res.setHeader('Cache-Control', 'no-cache');
    res.send(`<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Faz o L</title>
<meta property="og:site_name" content="Faz o L">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="video.other">
<meta property="og:video" content="${escapeHtml(video)}">
<meta property="og:video:secure_url" content="${escapeHtml(video)}">
<meta property="og:video:type" content="${escapeHtml(clip.mime)}">
<meta property="og:video:width" content="1280"><meta property="og:video:height" content="720">
<meta name="theme-color" content="#16191e">
<link rel="icon" href="/img/logo-faz-o-l.svg">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16191e;color:#eff3f9;font:15px/1.5 system-ui,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{width:min(1100px,100%)}video{width:100%;border-radius:10px;border:1px solid #353e4a;background:#0b0c0b}h1{font-size:22px;letter-spacing:-.03em;margin:14px 0 4px}p{margin:0 0 6px;color:#aeb9c9;white-space:pre-wrap}a{color:#9ec5fd}</style>
</head><body><main>
<video src="${escapeHtml(video)}" controls autoplay playsinline></video>
<h1>${escapeHtml(title)}</h1>
${clip.description ? `<p>${escapeHtml(clip.description)}</p>` : ''}
<p>${escapeHtml(byline)} • <a href="${escapeHtml(video)}" download>baixar</a> • <a href="/c/${escapeHtml(clip.channel_id)}">abrir o Faz o L</a></p>
</main></body></html>`);
  });

  return router;
}
