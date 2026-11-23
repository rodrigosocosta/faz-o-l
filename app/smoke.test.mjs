// Teste de fumaça do app (sem LiveKit/Discord): canais, convites, clipes, @marcações e perfis.
// Uso: DB_FILE=/tmp/t.db CLIPS_DIR=/tmp/clips SESSION_SECRET=x LIVEKIT_API_KEY=k LIVEKIT_API_SECRET=s \
//      DISCORD_CLIENT_ID=1 DISCORD_CLIENT_SECRET=2 CREATOR_DISCORD_IDS=11111 node smoke.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PORT = '3999';
process.env.PUBLIC_URL = 'http://localhost:3999';
await import('./src/index.js');
const { upsertUser, createChannel } = await import('./src/channels.js');
const { sql } = await import('./src/db.js');

function cookie(user) {
  const data = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 60_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(data).digest('base64url');
  return `fol_session=${data}.${sig}`;
}

const owner = { id: 'd11111', username: 'dono', name: 'Dono', avatar: '' };
const friend = { id: 'd222', username: 'amigo.legal', name: 'Amigo', avatar: '' };
const stranger = { id: 'd333', username: 'estranho', name: 'Estranho', avatar: '' };
for (const u of [owner, friend, stranger]) upsertUser(u);

async function call(user, method, path, body) {
  const res = await fetch(`http://localhost:3999${path}`, {
    method,
    headers: { cookie: user ? cookie(user) : '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}

await new Promise((r) => setTimeout(r, 300));

// Liberação pra criar canal
assert.equal((await call(owner, 'GET', '/api/me')).json.canCreate, true);
assert.equal((await call(friend, 'GET', '/api/me')).json.canCreate, false);
assert.equal((await call(friend, 'GET', '/auth/install')).headers.get('location'), '/?erro=liberacao');

const channel = createChannel({ guildId: '999', name: 'Amigos do João', ownerId: owner.id });

// Sem convite: não entra
assert.equal((await call(friend, 'GET', `/api/c/${channel.id}`)).status, 403);
assert.equal((await call(friend, 'POST', `/api/c/${channel.id}/invites`, {})).status, 403);

// Convite do dono
const invite = (await call(owner, 'POST', `/api/c/${channel.id}/invites`, { days: 1, maxUses: 1 })).json;
assert.match(invite.url, /\/convite\//);
const info = (await call(null, 'GET', `/api/invites/${invite.code}`)).json;
assert.equal(info.channel.name, 'Amigos do João');
assert.equal(info.valid, true);
assert.equal((await call(friend, 'POST', `/api/invites/${invite.code}/accept`)).json.channelId, channel.id);
// 1 uso só
assert.equal((await call(stranger, 'POST', `/api/invites/${invite.code}/accept`)).status, 410);
assert.equal((await call(friend, 'GET', `/api/c/${channel.id}`)).json.role, 'member');
assert.equal((await call(friend, 'GET', '/api/channels')).json.channels.length, 1);

// Clipe (inserido direto: o gravador não roda aqui)
const now = Date.now();
sql(`INSERT INTO clips (id, channel_id, file, mime, seconds, streamer_id, streamer_name, creator_id, creator_name, created_at)
     VALUES ('clip1', ?, 'clip1.webm', 'video/webm', 30, ?, 'Dono', ?, 'Amigo', ?)`).run(channel.id, owner.id, friend.id, now);

// Só quem clipou edita; @ de membro vira marcação, @ de quem não é membro não
assert.equal((await call(owner, 'PATCH', '/api/clips/clip1', { title: 'x' })).status, 403);
const edited = (await call(friend, 'PATCH', '/api/clips/clip1', {
  title: 'Que jogada @dono!',
  description: 'olha isso @Amigo. e @estranho',
  publish: true,
})).json;
assert.deepEqual(edited.mentions.map((u) => u.username).sort(), ['amigo.legal', 'dono']);
// @nome de exibição vira o @ do Discord
assert.equal(edited.description, 'olha isso @amigo.legal. e @estranho');
assert.equal(sql('SELECT published FROM clips WHERE id = ?').get('clip1').published, 1);
// Editar depois de postado avisa o bot para atualizar o post
const { liveEvents } = await import('./src/livekit.js');
const updated = new Promise((resolve) => liveEvents.once('clip:updated', resolve));
await call(friend, 'PATCH', '/api/clips/clip1', { description: 'olha isso @Amigo. e @estranho!' });
assert.equal((await updated).clip.description, 'olha isso @amigo.legal. e @estranho!');
await call(friend, 'PATCH', '/api/clips/clip1', { description: 'olha isso @amigo.legal. e @estranho' });

// Salvar: qualquer membro do canal; quem não é do canal não
assert.equal((await call(stranger, 'PATCH', '/api/clips/clip1', { saved: true })).status, 403);
const savedByOwner = (await call(owner, 'PATCH', '/api/clips/clip1', { saved: true })).json;
assert.equal(savedByOwner.saved, true);
assert.equal(savedByOwner.savedBy, owner.name);
// Quem clipou também pode tirar dos salvos; membro qualquer, só se foi ele que salvou
assert.equal((await call(friend, 'PATCH', '/api/clips/clip1', { saved: false })).json.saved, false);
assert.equal((await call(friend, 'PATCH', '/api/clips/clip1', { saved: true })).json.canUnsave, true);

// Perfis
const ownerProfile = (await call(friend, 'GET', '/api/users/dono')).json;
assert.equal(ownerProfile.streamed.length, 1);
assert.equal(ownerProfile.tagged.length, 1);
const friendProfile = (await call(owner, 'GET', '/api/users/AMIGO.LEGAL')).json;
assert.equal(friendProfile.tagged.length, 1);
assert.equal(friendProfile.streamed.length, 0);
// Quem não é do canal não vê os clipes
assert.equal((await call(stranger, 'GET', '/api/users/dono')).json.streamed.length, 0);

// Página do clipe com título
const page = await call(null, 'GET', '/clip/clip1');
assert.match(page.text, /og:title" content="Que jogada @dono!"/);

// Rotas do site servem o index.html
assert.match((await call(null, 'GET', `/c/${channel.id}`)).text, /<title>Faz o L<\/title>/);
assert.match((await call(null, 'GET', '/u/dono')).text, /view-profile/);

// Evento (YouTube junto)
const { youtubeId } = await import('./src/events.js');
assert.equal(youtubeId('https://www.youtube.com/watch?v=wpBaB5NN3Nk'), 'wpBaB5NN3Nk');
assert.equal(youtubeId('https://youtu.be/wpBaB5NN3Nk?t=10'), 'wpBaB5NN3Nk');
assert.equal(youtubeId('youtube.com/live/wpBaB5NN3Nk'), 'wpBaB5NN3Nk');
assert.equal(youtubeId('https://exemplo.com/watch?v=wpBaB5NN3Nk'), null);
const evUrl = `/api/c/${channel.id}/event`;
assert.equal((await call(stranger, 'POST', evUrl, { url: 'wpBaB5NN3Nk' })).status, 403);
assert.equal((await call(friend, 'POST', evUrl, { url: 'nada' })).status, 400);
const started = (await call(friend, 'POST', evUrl, { url: 'https://www.youtube.com/watch?v=wpBaB5NN3Nk', title: 'Final' })).json;
assert.equal(started.event.videoId, 'wpBaB5NN3Nk');
assert.equal(started.event.title, 'Final');
assert.equal(started.event.playing, true);
// Só quem começou ou o dono controla
assert.equal((await call(stranger, 'PATCH', evUrl, { action: 'pause' })).status, 403);
const paused = (await call(friend, 'PATCH', evUrl, { action: 'pause', position: 42 })).json.event;
assert.equal(paused.playing, false);
assert.equal(paused.position, 42);
assert.equal((await call(owner, 'GET', evUrl)).json.event.position, 42);
assert.equal((await call(owner, 'PATCH', evUrl, { action: 'play' })).json.event.playing, true);
assert.equal((await call(owner, 'DELETE', evUrl)).status, 200);
assert.equal((await call(friend, 'GET', evUrl)).json.event, null);
// Twitch: canal (live) e vídeo gravado
const { twitchMedia } = await import('./src/events.js');
assert.deepEqual(twitchMedia('https://www.twitch.tv/Gaules'), { kind: 'channel', id: 'gaules' });
assert.deepEqual(twitchMedia('twitch.tv/videos/2245678901'), { kind: 'video', id: '2245678901' });
assert.equal(twitchMedia('https://www.twitch.tv/directory'), null);
const tw = (await call(friend, 'POST', evUrl, { url: 'https://twitch.tv/gaules' })).json.event;
assert.equal(tw.source, 'twitch');
assert.equal(tw.twitch.id, 'gaules');
assert.equal(tw.title, 'Live de gaules na Twitch');
assert.equal((await call(friend, 'DELETE', evUrl)).status, 200);

// Dono remove membro
assert.equal((await call(owner, 'DELETE', `/api/c/${channel.id}/members/${friend.id}`)).status, 200);
assert.equal((await call(friend, 'GET', `/api/c/${channel.id}`)).status, 403);
assert.equal((await call(owner, 'DELETE', `/api/c/${channel.id}/members/${owner.id}`)).status, 400);

console.log('SMOKE OK');
process.exit(0);
