import { logger } from './logger.js';
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { canCreateChannels, createChannel, discordBridge, getChannelByGuild, upsertUser } from './channels.js';

const SESSION_COOKIE = 'fol_session';
const STATE_COOKIE = 'fol_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const DISCORD_API = 'https://discord.com/api/v10';

// ---------- cookies assinados ----------

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

// typ separa os cookies assinados: um cookie de login não vale como sessão e vice-versa.
function encodeSigned(payload, ttlMs, typ) {
  const data = Buffer.from(JSON.stringify({ ...payload, typ, exp: Date.now() + ttlMs })).toString('base64url');
  return `${data}.${sign(data)}`;
}

function decodeSigned(value, typ) {
  if (!value) return null;
  const [data, sig] = value.split('.');
  if (!data || !sig) return null;
  const expected = sign(data);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    // Sessões emitidas antes do typ continuam válidas até expirarem.
    const legacySession = typ === 'session' && parsed.typ === undefined;
    if (parsed.typ !== typ && !legacySession) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function cookieOptions(maxAge) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', maxAge, path: '/' };
}

function setSession(res, user) {
  res.cookie(SESSION_COOKIE, encodeSigned(user, SESSION_TTL_MS, 'session'), cookieOptions(SESSION_TTL_MS));
}

/** Middleware: popula req.user a partir do cookie. */
export function sessionMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  let session = decodeSigned(req.cookies[SESSION_COOKIE], 'session');
  if (session && typeof session.id !== 'string') session = null;
  // Sessão de antes dos perfis (sem o @ do Discord): pede login de novo
  if (session && session.id.startsWith('d') && session.username === undefined) session = null;
  req.user = session ? { id: session.id, username: session.username || '', name: session.name, avatar: session.avatar } : null;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login primeiro.' });
  next();
}

// ---------- helpers ----------

function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
}

function discordAvatar(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function discordFetch(path, accessToken) {
  const res = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Discord ${path} respondeu ${res.status}`);
  return res.json();
}

// ---------- rotas ----------

/** Só caminhos internos (evita redirecionar pra outro site depois do login). */
function safeNext(next) {
  const value = String(next || '/');
  return /^\/(?![/\\])/.test(value) ? value : '/';
}

function iconUrl(guild) {
  return guild?.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : '';
}

export function authRouter() {
  const router = express.Router();
  const redirectUri = `${config.publicUrl}/auth/callback`;

  function startOAuth(res, { mode, next, params }) {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, encodeSigned({ state, mode, next: safeNext(next) }, STATE_TTL_MS, 'state'), cookieOptions(STATE_TTL_MS));
    const query = new URLSearchParams({
      client_id: config.discord.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      ...params,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${query}`);
  }

  router.get('/auth/login', (req, res) => {
    if (config.authMode !== 'discord') return res.redirect('/');
    startOAuth(res, { mode: 'login', next: req.query.next, params: { scope: 'identify', prompt: 'none' } });
  });

  // Colocar o bot num servidor = criar um canal (só pra quem está liberado)
  router.get('/auth/install', (req, res) => {
    if (config.authMode !== 'discord') return res.redirect('/');
    if (!canCreateChannels(req.user)) return res.redirect('/?erro=liberacao');
    startOAuth(res, {
      mode: 'install',
      params: { scope: 'identify bot applications.commands', permissions: '19456' },
    });
  });

  router.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const saved = decodeSigned(req.cookies[STATE_COOKIE], 'state') || {};
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!code || !state || state !== saved.state) return res.redirect('/?erro=login');

    try {
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
      const grant = await tokenRes.json();
      const user = await discordFetch('/users/@me', grant.access_token);

      const session = {
        id: `d${user.id}`,
        username: user.username,
        name: cleanName(user.global_name || user.username) || 'Sem nome',
        avatar: discordAvatar(user),
      };
      upsertUser(session);
      setSession(res, session);

      if (saved.mode === 'install') {
        const guild = grant.guild || (req.query.guild_id ? { id: String(req.query.guild_id) } : null);
        if (!guild) return res.redirect('/?erro=instalacao');
        if (!canCreateChannels(session)) {
          if (!getChannelByGuild(guild.id)) await discordBridge.leaveGuild?.(guild.id).catch(() => {});
          return res.redirect('/?erro=liberacao');
        }
        const channel = getChannelByGuild(guild.id) ||
          createChannel({ guildId: guild.id, name: guild.name || 'Servidor', icon: iconUrl(guild), ownerId: session.id });
        return res.redirect(`/c/${channel.id}?novo=1`);
      }
      res.redirect(safeNext(saved.next));
    } catch (err) {
      logger.error('[auth] Falha no login do Discord:', err);
      res.redirect('/?erro=login');
    }
  });

  router.post('/api/guest', express.json(), (req, res) => {
    if (config.authMode !== 'guest') return res.status(403).json({ error: 'Use o login do Discord.' });
    const name = cleanName(req.body?.name);
    if (name.length < 2) return res.status(400).json({ error: 'Escolha um apelido com pelo menos 2 letras.' });
    const session = { id: `g${crypto.randomBytes(6).toString('hex')}`, username: '', name, avatar: '' };
    upsertUser(session);
    setSession(res, session);
    res.json({ ok: true });
  });

  router.post('/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return router;
}
