import {
  AudioPresets,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoQuality,
} from '/vendor/livekit/livekit-client.esm.mjs';

// Perfis de transmissão. "layer" é a versão menor enviada junto (simulcast)
// para quem escolher "Economia" ou estiver com internet fraca.
const QUALITY = {
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, layer: [1280, 720, 2_500_000, 30] },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000, layer: [1280, 720, 1_800_000, 30] },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 4_000_000, layer: [854, 480, 1_000_000, 30] },
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, layer: [854, 480, 800_000, 30] },
};

// Versão do site (aparece no painel; ajuda a saber se o app pegou o código novo)
const SITE_VERSION = '2026-11-27.1';

const $ = (sel) => document.querySelector(sel);
const state = {
  me: null,
  limits: { maxStreamers: 2, maxViewers: 15 },
  room: null,
  tiles: new Map(), // identity -> tile
  focus: null,
  local: null, // { video, audio } MediaStreamTracks enquanto transmite
  busy: false,
  leaving: false,
};

// ---------------- utilidades ----------------

const store = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* sem storage */ }
  },
};

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}


function avatarOf(participant) {
  try { return JSON.parse(participant.metadata || '{}').avatar || ''; } catch { return ''; }
}

function usernameOf(participant) {
  try { return JSON.parse(participant.metadata || '{}').username || ''; } catch { return ''; }
}

function livekitUrl(fromServer) {
  if (fromServer) return fromServer;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

// ---------------- peças visuais (kit de design) ----------------

/** Ícone do sprite do kit (grade 24 × 24, traço de 1,8 px). */
function ico(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/img/icones.svg#i-${name}`);
  svg.append(use);
  return svg;
}

function setIco(el, name) {
  el.querySelector('use')?.setAttribute('href', `/img/icones.svg#i-${name}`);
}

const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

/** Cor estável por nome para as iniciais (tons do kit). */
function tint(name = '') {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return { bg: `hsl(${h} 22% 30%)`, ink: `hsl(${h} 70% 88%)` };
}

/** Preenche um avatar (círculo) ou marca de canal (quadrado) com a foto ou as iniciais. */
function fillMark(el, name, image) {
  el.replaceChildren();
  if (image) {
    const img = document.createElement('img');
    img.src = image;
    img.alt = '';
    img.loading = 'lazy';
    el.append(img);
  } else {
    el.textContent = initials(name);
  }
  const { bg, ink } = tint(name);
  el.style.setProperty('--avatar-bg', bg);
  el.style.setProperty('--avatar-ink', ink);
}

function makeAvatar(name, image, extra = '') {
  const span = document.createElement('span');
  span.className = `avatar ${extra}`.trim();
  span.setAttribute('aria-hidden', 'true');
  fillMark(span, name, image);
  return span;
}

function makeMark(name, image) {
  const span = document.createElement('span');
  span.className = 'channel-mark';
  span.setAttribute('aria-hidden', 'true');
  fillMark(span, name, image);
  return span;
}

/** Botão com ícone e texto, no padrão .button do kit. */
function makeButton(label, icon, classes = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `button ${classes}`.trim();
  if (icon) b.append(ico(icon));
  if (label) b.append(label);
  return b;
}

function makeIconButton(label, icon, classes = 'ghost') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `icon-btn ${classes}`.trim();
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(ico(icon));
  return b;
}

/** Confirmação curta (encerrar, excluir, revogar, remover) com o objeto da ação identificado. */
function confirmAction(title, text, okLabel) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  return new Promise((resolve) => {
    const done = (value) => {
      dlg.removeEventListener('close', onClose);
      $('#confirm-ok').onclick = null;
      $('#confirm-cancel').onclick = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onClose = () => done(false);
    dlg.addEventListener('close', onClose);
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dlg.showModal();
    $('#confirm-cancel').focus();
  });
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    prompt('Copie o link:', text);
  }
}

// Botões [data-close] fecham o diálogo em que estão
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) close.closest('dialog')?.close();
});

// ---------------- tema e barra lateral ----------------

const compactViewport = matchMedia('(max-width: 970px)');

function applyTheme() {
  const light = store.get('theme', 'dark') === 'light';
  if (light) document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#f4f6fa' : '#0f1218');
}

function applySidebar() {
  const pref = store.get('sidebar', '');
  const collapsed = pref ? pref === 'collapsed' : compactViewport.matches;
  $('#app').dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
  const toggle = $('#sidebar-toggle');
  const label = collapsed ? 'Expandir barra lateral' : 'Recolher barra lateral';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  setIco(toggle, collapsed ? 'sidebar-expand' : 'sidebar-collapse');
}
compactViewport.addEventListener('change', applySidebar);
$('#sidebar-toggle').addEventListener('click', () => {
  store.set('sidebar', $('#app').dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed');
  applySidebar();
});
applyTheme();
applySidebar();

// ---------------- navegação ----------------
// Rotas: /  (meus canais) • /c/<id> (sala) • /c/<id>/clipes[/<clipe>] • /u/<@> (perfil) • /convite/<código>

const VIEWS = ['view-home', 'view-invite', 'view-join', 'view-room', 'view-clips', 'view-profile'];
// Página atual na barra lateral: canais, sala, clipes ou perfil
const NAV_OF_VIEW = { 'view-home': 'home', 'view-invite': 'home', 'view-join': 'room', 'view-room': 'room', 'view-clips': 'clips', 'view-profile': 'profile' };

function show(view) {
  const login = view === 'view-login';
  $('#view-login').hidden = !login;
  $('#app').hidden = login;
  if (login) return;
  for (const id of VIEWS) $(`#${id}`).hidden = id !== view;
  renderChrome(NAV_OF_VIEW[view]);
}

/** Barra lateral e cabeçalho: canal atual, página atual e ações da sala. */
function renderChrome(current = state.nav) {
  state.nav = current;
  const c = state.channel;
  for (const [id, key] of [['#nav-home', 'home'], ['#nav-room', 'room'], ['#nav-clips', 'clips']]) {
    if (current === key) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  const ownProfile = current === 'profile' && state.profileUser && state.profileUser === state.me?.username;
  for (const id of ['#btn-profile', '#btn-profile-mobile']) {
    if (ownProfile) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  for (const id of ['#nav-room', '#nav-clips']) $(id).setAttribute('aria-disabled', String(!c));
  $('#nav-channel-label').textContent = c ? c.name : 'Canal atual';
  $('#nav-room').href = c ? `/c/${c.id}` : '/';
  $('#nav-clips').href = c ? `/c/${c.id}/clipes` : '/';
  $('#shelf-all').href = c ? `/c/${c.id}/clipes` : '/';

  if (state.me) {
    $('#side-name').textContent = state.me.name;
    fillMark($('#side-avatar'), state.me.name, state.me.avatar);
    const href = profileHref(state.me.username);
    for (const id of ['#btn-profile', '#btn-profile-mobile']) {
      $(id).href = href;
      $(id).hidden = !state.me.username;
    }
  }

  // Cabeçalho: canal atual em sala/clipes; marca do Faz o L nas outras páginas
  const title = $('#topbar-title');
  const inChannel = c && (current === 'room' || current === 'clips');
  if (inChannel) {
    const name = document.createElement('span');
    name.textContent = c.name;
    title.replaceChildren(makeMark(c.name, c.icon), name);
  } else {
    const img = document.createElement('img');
    img.src = '/img/logo-faz-o-l.svg';
    img.width = 29;
    img.height = 29;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = 'Faz o L';
    title.replaceChildren(img, name);
  }
  renderRoomActions();
}

/** Transmitir / Encerrar live / Começar evento no cabeçalho (só com a sala aberta). */
function renderRoomActions() {
  const inRoom = !!state.room && !$('#view-room').hidden;
  const appLive = !!myAppStream();
  const live = !!state.local || appLive;
  $('#btn-broadcast').hidden = !inRoom || live;
  $('#btn-stop-live').hidden = !inRoom || !live;
  $('#btn-stop-live').disabled = appLive && !state.local;
  $('#btn-stop-live').title = appLive && !state.local ? 'Você está ao vivo pelo app: pare por lá' : '';
  $('#btn-stop-live-text').textContent = appLive && !state.local ? 'Ao vivo pelo app' : 'Encerrar live';
  let hasEvent = false;
  try { hasEvent = !!ev.data; } catch { /* evento ainda não carregado */ }
  $('#btn-event').hidden = !inRoom || hasEvent;
  $('#btn-event').querySelector('span').textContent = 'Começar evento';
}

/** Caminho da API do canal atual. */
const ch = (path) => `/api/c/${state.channel.id}${path}`;

async function navigate(path, { replace = false } = {}) {
  if (path !== location.pathname + location.search) {
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
  }
  return route();
}

// Links internos (data-link) navegam sem recarregar a página
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', () => route());

function profileHref(username) {
  return username ? `/u/${encodeURIComponent(username)}` : '#';
}

async function route() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);

  if (!state.me) {
    const me = await api('/api/me');
    state.limits = me.limits;
    state.authMode = me.authMode;
    state.canCreate = me.canCreate;
    state.me = me.user;
  }
  if (!state.me) return showLogin(params.get('erro'), path);

  const channelMatch = path.match(/^\/c\/([\w-]+)/);
  const clipsMatch = path.match(/^\/c\/([\w-]+)\/clipes(?:\/([\w-]+))?/);
  const inviteMatch = path.match(/^\/convite\/([\w-]+)/);
  const profileMatch = path.match(/^\/u\/([^/]+)/);

  // Navegar pelo site mantém a sala e a transmissão. Só desconecta ao trocar de canal.
  const leavingRoom = channelMatch && channelMatch[1] !== state.channel?.id;
  if (state.room && leavingRoom) await leave();
  if (!clipsMatch) $('#clip-player').pause();
  if (inviteMatch) return showInvite(inviteMatch[1]);
  if (profileMatch) return showProfile(decodeURIComponent(profileMatch[1]));
  if (clipsMatch) return showClipsPage(clipsMatch[1], clipsMatch[2] || null);
  if (channelMatch) {
    if (params.get('novo')) {
      toast('Canal criado! Abra Configurações → Canal pra convidar a galera.');
      history.replaceState(null, '', path);
    }
    return showChannel(channelMatch[1]);
  }
  return showHome(params.get('erro'));
}

// ---------------- login ----------------

const LOGIN_ERRORS = {
  login: 'Não foi possível fazer login. Tente de novo.',
  liberacao: 'Sua conta não está liberada para criar canais. Peça pro dono do Faz o L.',
  instalacao: 'Não deu pra colocar o bot no servidor. Tente de novo.',
};

function showLogin(erro, next) {
  show('view-login');
  $('#btn-discord').hidden = state.authMode !== 'discord';
  $('#btn-discord').href = `/auth/login?next=${encodeURIComponent(next || '/')}`;
  $('#form-guest').hidden = state.authMode !== 'guest';
  $('#login-sub').textContent = next?.startsWith('/convite/')
    ? 'Entre com o Discord para aceitar o convite.'
    : 'Transmita sua tela pra galera com quase zero de delay.';
  if (erro) {
    $('#login-error').textContent = LOGIN_ERRORS[erro] || LOGIN_ERRORS.login;
    $('#login-error').hidden = false;
    history.replaceState(null, '', location.pathname);
  }
}

$('#form-guest').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/guest', { method: 'POST', body: { name: $('#guest-name').value } });
    state.me = null;
    route();
  } catch (err) {
    toast(err.message, true);
  }
});

async function logout() {
  await leave();
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}
$('#btn-logout-home').addEventListener('click', logout);
$('#btn-logout-profile').addEventListener('click', logout);

// ---------------- meus canais ----------------

async function showHome(erro) {
  show('view-home');
  document.title = 'Faz o L';
  $('#home-error').hidden = !erro;
  if (erro) {
    $('#home-error').textContent = LOGIN_ERRORS[erro] || LOGIN_ERRORS.login;
    history.replaceState(null, '', '/');
  }
  $('#btn-create').hidden = !state.canCreate;

  let channels = [];
  try {
    ({ channels } = await api('/api/channels'));
  } catch (err) {
    toast(err.message, true);
  }
  // Na primeira visita, com um canal só: entra direto nele
  const first = !state.visitedHome;
  state.visitedHome = true;
  if (channels.length === 1 && !erro && first && !state.room) return navigate(`/c/${channels[0].id}`, { replace: true });

  $('#no-channels').hidden = channels.length > 0;
  $('#channel-list').replaceChildren(
    ...channels.map((c) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'channel-row';
      a.href = `/c/${c.id}`;
      a.dataset.link = '';
      const text = document.createElement('span');
      text.className = 'channel-text';
      const name = document.createElement('strong');
      name.textContent = c.name;
      const role = document.createElement('small');
      role.textContent = c.role === 'owner' ? 'Dono' : 'Membro';
      text.append(name, role);
      a.append(makeMark(c.name, c.icon), text, ico('right'));
      li.append(a);
      return li;
    }),
  );
}

// ---------------- convite ----------------

async function showInvite(code) {
  show('view-invite');
  $('#invite-error').hidden = true;
  $('#btn-accept').hidden = false;
  try {
    const info = await api(`/api/invites/${code}`);
    $('#invite-name').textContent = info.channel.name;
    fillMark($('#invite-mark'), info.channel.name, info.channel.icon);
    if (info.member) return navigate(`/c/${info.channel.id}`, { replace: true });
    if (!info.valid) {
      $('#invite-error').textContent = 'Esse convite expirou ou já foi usado. Peça outro pro dono do canal.';
      $('#invite-error').hidden = false;
      $('#btn-accept').hidden = true;
    }
    $('#btn-accept').onclick = async () => {
      try {
        const { channelId } = await api(`/api/invites/${code}/accept`, { method: 'POST' });
        toast(`Bem-vindo ao ${info.channel.name}!`);
        navigate(`/c/${channelId}`, { replace: true });
      } catch (err) {
        toast(err.message, true);
      }
    };
  } catch (err) {
    $('#invite-name').textContent = 'Convite indisponível';
    fillMark($('#invite-mark'), '?', '');
    $('#invite-error').textContent = err.message;
    $('#invite-error').hidden = false;
    $('#btn-accept').hidden = true;
  }
}

// ---------------- canal ----------------

/** Carrega o canal (se ainda não for o atual). false = sem acesso, já voltou pra home. */
async function loadChannel(id) {
  if (state.channel?.id === id) return true;
  try {
    state.channel = await api(`/api/c/${id}`);
  } catch (err) {
    toast(err.message, true);
    navigate('/', { replace: true });
    return false;
  }
  state.limits = state.channel.limits;
  state.members = null;
  clipsView.clips = [];
  renderClipsPanel([]);
  startClipsRefresh();
  return true;
}

async function showChannel(id) {
  if (state.room && state.channel?.id === id) {
    document.title = `${state.channel.name} • Faz o L`;
    show('view-room');
    renderClipShelf();
    return;
  }
  if (!(await loadChannel(id))) return;
  const c = state.channel;
  document.title = `${c.name} • Faz o L`;
  $('#join-channel').textContent = c.name;
  fillMark($('#join-mark'), c.name, c.icon);
  show('view-join');
  refreshJoinStatus();
  await join();
}

async function refreshJoinStatus() {
  $('#join-status').textContent = `Você está conectado como ${state.me.name}.`;
  try {
    const s = await api(ch('/status'));
    const live = s.streamers.filter((x) => x.live);
    $('#join-status').textContent = live.length
      ? `${live.length} de ${state.limits.maxStreamers} ao vivo: ${live.map((x) => x.name).join(' e ')} · ${s.viewers} assistindo · Você está conectado como ${state.me.name}.`
      : `Nenhuma transmissão ao vivo · ${s.total} na sala · Você está conectado como ${state.me.name}.`;
  } catch { /* fica só o nome */ }
}

/** Membros do canal (pra marcar com @). */
async function channelMembers() {
  if (!state.members) {
    try {
      state.members = (await api(ch('/members'))).members;
    } catch {
      state.members = [];
    }
  }
  return state.members;
}

// ---------------- sala ----------------

$('#btn-join').addEventListener('click', join);

// Transmitir: o diálogo explica de onde vem a captura e mostra as vagas
function openBroadcast() {
  if (!state.room) return;
  renderPresence();
  $('#dlg-broadcast').showModal();
}
$('#btn-broadcast').addEventListener('click', openBroadcast);
for (const b of document.querySelectorAll('[data-open-broadcast]')) b.addEventListener('click', openBroadcast);
$('#form-broadcast').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.local) return;
  startStream();
});
$('#btn-stop-live').addEventListener('click', async () => {
  if (!state.local) return;
  if (await confirmAction('Encerrar live?', 'Sua transmissão e o compartilhamento de tela serão encerrados.', 'Encerrar live')) stopStream();
});

async function join() {
  const btn = $('#btn-join');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Entrando…';
  try {
    // Dentro do app desktop a página entra como "<id>:app": dá pra estar ao mesmo
    // tempo no app (transmitindo) e no navegador (assistindo) sem um derrubar o outro
    const { token, url } = await api(ch('/token'), { method: 'POST', body: { client: desktop ? 'desktop' : 'web' } });

    const room = new Room({
      adaptiveStream: false, // a qualidade é escolhida pelo espectador
      dynacast: true, // o streamer só envia as camadas que alguém está assistindo
      disconnectOnPageLeave: true,
    });
    state.room = room;
    state.leaving = false;
    wireRoom(room);

    await room.connect(livekitUrl(url), token);
    await room.startAudio().catch(() => {});
    loadEvent();

    show('view-room');
    state.layoutMode = store.get('layout', 'theater');
    layout();
    renderPresence();
    startClipsRefresh();
  } catch (err) {
    toast(err.message || 'Não foi possível entrar na sala.', true);
    state.room = null;
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Entrar na sala';
  }
}

async function leave() {
  if (!state.room) return;
  state.leaving = true;
  exitPip();
  if (state.mini) await setMiniMode(null);
  await stopStream();
  await state.room.disconnect();
  state.room = null;
  for (const id of [...state.tiles.keys()]) removeTile(id);
  renderRoomActions();
}

function wireRoom(room) {
  room
    .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
    .on(RoomEvent.ParticipantConnected, renderPresence)
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      removeTile(p.identity);
      renderPresence();
    })
    .on(RoomEvent.TrackPublished, renderPresence)
    .on(RoomEvent.TrackUnpublished, renderPresence)
    .on(RoomEvent.ParticipantMetadataChanged, renderPresence)
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      // Tela parada pelo navegador ou pelo servidor
      if (pub.source === Track.Source.ScreenShare) stopStream();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) toast('Clique em qualquer lugar da página para liberar o som.');
    })
    .on(RoomEvent.Reconnecting, () => toast('Conexão instável, reconectando…'))
    .on(RoomEvent.Reconnected, () => {
      toast('Reconectado!');
      loadEvent();
    })
    .on(RoomEvent.RoomMetadataChanged, onRoomMetadata)
    .on(RoomEvent.DataReceived, onEventSyncData)
    .on(RoomEvent.Disconnected, (reason) => {
      if (state.leaving) return;
      state.room = null;
      cleanupLocal();
      for (const id of [...state.tiles.keys()]) removeTile(id);
      const msg = reason === DisconnectReason.DUPLICATE_IDENTITY
        ? 'Você entrou em outra aba/dispositivo.'
        : 'Você foi desconectado da sala.';
      toast(msg, true);
      if (!$('#view-room').hidden) {
        show('view-join');
        refreshJoinStatus();
      }
    });
}

// Desbloqueia áudio no primeiro clique, se o navegador bloqueou
document.addEventListener('click', () => {
  if (state.room && !state.room.canPlaybackAudio) state.room.startAudio().catch(() => {});
});

function onTrackSubscribed(track, publication, participant) {
  // Vozes do Discord de quem transmite pelo app: ninguém escuta ao vivo (todo mundo já
  // está na call e ouviria duas vezes); o gravador junta essa trilha nos clipes.
  if (publication.trackName === 'voices') {
    publication.setSubscribed(false);
    return;
  }
  // A própria transmissão feita pelo app desktop, vista DENTRO do app: o áudio nunca
  // volta (eco); o vídeo aparece como prévia, se a opção estiver ligada.
  // No navegador ela aparece como uma live normal (o som começa mudo, ver abaixo).
  const ownAppStream = state.me && participant.identity === state.me.id + DESKTOP_SUFFIX;
  if (ownAppStream && desktop) {
    if (track.kind !== Track.Kind.Video || !selfPreviewEnabled()) {
      publication.setSubscribed(false);
      return;
    }
    const tile = ensureTile(participant.identity, `${participant.name || 'Você'} • prévia`, true);
    tile.publication = publication;
    track.attach(tile.video);
    tile.el.classList.add('has-video');
    publication.setVideoQuality(VideoQuality.HIGH);
    updateResolution(tile, track);
    renderPresence();
    return;
  }
  const tileName = ownAppStream ? `${participant.name || 'Você'} (você, pelo app)` : participant.name || participant.identity;
  if (track.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
    const tile = ensureTile(participant.identity, tileName);
    tile.publication = publication;
    track.attach(tile.video);
    tile.el.classList.add('has-video');
    applyQuality(tile);
    updateResolution(tile, track);
  } else if (track.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio) {
    const tile = ensureTile(participant.identity, tileName);
    // Toda live começa muda (a sua, no mesmo PC, ainda daria eco se desmutar)
    if (ownAppStream && !tile.ownAudioWarned) {
      tile.ownAudioWarned = true;
      toast('O som da sua live está mudo (no mesmo PC daria eco).');
    }
    tile.audioTrack = track;
    const el = track.attach();
    $('#audio-sink').append(el);
    applyVolume(tile);
  }
  renderPresence();
}

function onTrackUnsubscribed(track, publication, participant) {
  const els = track.detach();
  for (const el of els) if (el.tagName === 'AUDIO') el.remove();
  const tile = state.tiles.get(participant.identity);
  if (!tile) return;
  if (track.kind === Track.Kind.Video) {
    removeTile(participant.identity);
  } else if (tile.audioTrack === track) {
    // Só o som da live: a trilha "voices" (recusada ao chegar) também passa por aqui,
    // e zerar o som da live por causa dela deixava a live sem áudio ao desmutar
    tile.audioTrack = null;
    applyVolume(tile);
  }
  renderPresence();
}

// ---------------- tiles ----------------

function ensureTile(id, name, isLocal = false) {
  let tile = state.tiles.get(id);
  if (tile) return tile;

  const el = $('#tpl-tile').content.firstElementChild.cloneNode(true);
  tile = {
    id,
    el,
    isLocal,
    name,
    video: el.querySelector('video'),
    publication: null,
    audioTrack: null,
    volume: Number(store.get(`vol:${id}`, '1')),
    muted: true, // toda live começa sem som: quem assiste desmuta
    quality: store.get('quality', 'high'),
  };
  const who = id === '__local__' ? state.me : state.room?.remoteParticipants.get(id);
  const personName = id === '__local__' ? state.me?.name : who?.name || name;
  const avatar = id === '__local__' ? state.me?.avatar : who ? avatarOf(who) : '';
  fillMark(el.querySelector('.tile-avatar'), personName || name, avatar);
  el.querySelector('.tile-name').textContent = isLocal ? `${name} (você)` : name;
  el.querySelector('.tile-sub').textContent = isLocal ? 'Sua transmissão' : 'Transmitindo a tela';
  el.setAttribute('aria-label', `Live de ${personName || name}`);
  if (isLocal) el.classList.add('local');

  const volume = el.querySelector('.ctl-volume');
  const mute = el.querySelector('.ctl-mute');
  const quality = el.querySelector('.ctl-quality');
  volume.value = String(tile.volume);
  quality.value = tile.quality;

  if (isLocal) {
    // No próprio preview não toca o seu áudio (evita eco)
    volume.hidden = true;
    mute.hidden = true;
    quality.hidden = true;
    const stop = el.querySelector('.ctl-stop');
    stop.hidden = false;
    stop.addEventListener('click', stopStream);
  }

  volume.addEventListener('input', () => {
    tile.volume = Number(volume.value);
    tile.muted = tile.volume === 0;
    store.set(`vol:${id}`, String(tile.volume));
    applyVolume(tile);
  });
  mute.addEventListener('click', () => {
    tile.muted = !tile.muted;
    applyVolume(tile);
  });
  quality.addEventListener('change', () => {
    tile.quality = quality.value;
    store.set('quality', tile.quality);
    applyQuality(tile);
  });
  wireViewControls(tile);
  const pip = el.querySelector('.ctl-pip');
  pip.hidden = !desktop && !pipSupported(tile.video);
  pip.addEventListener('click', () => togglePip(tile));
  // No modo mini do app: arrastar a live move a janela, duplo clique volta ao normal
  el.addEventListener('mousedown', (e) => {
    if (state.mini !== id || e.button !== 0 || e.target.closest('button, input, select, .clip-menu')) return;
    desktop.window.getCurrentWindow().startDragging().catch(() => {});
  });
  el.querySelector('.pip-back').addEventListener('click', (e) => {
    e.stopPropagation();
    exitPip();
  });
  tile.video.addEventListener('enterpictureinpicture', () => setPipState(tile, true));
  tile.video.addEventListener('leavepictureinpicture', () => setPipState(tile, false));
  tile.video.addEventListener('webkitpresentationmodechanged', () => {
    setPipState(tile, tile.video.webkitPresentationMode === 'picture-in-picture');
  });
  el.querySelector('.screen').addEventListener('dblclick', () => {
    if (state.mini === id) setMiniMode(null);
    else toggleFullscreen(el);
  });

  // Clipar: três durações rápidas + a lista completa (gerado no servidor)
  const clipMenu = el.querySelector('.clip-menu');
  el.querySelector('.ctl-clip').addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = clipMenu.hidden;
    closeClipMenus();
    if (!opening) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    fillClipMenu(clipMenu, tile);
    clipMenu.hidden = false;
    el.classList.add('clip-open');
    clipMenu.querySelector('button')?.focus();
  });
  clipMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const seconds = Number(e.target.closest('button')?.dataset.seconds);
    if (!seconds) return;
    closeClipMenus();
    // Preview do navegador: a live é publicada com a identidade do próprio usuário
    createClip(id === '__local__' ? state.me.id : id, seconds, tile);
  });
  clipMenu.addEventListener('change', (e) => {
    const seconds = Number(e.target.value);
    if (!seconds) return;
    closeClipMenus();
    createClip(id === '__local__' ? state.me.id : id, seconds, tile);
  });

  applyVolume(tile);
  state.tiles.set(id, tile);
  $('#stage').append(el);
  layout();
  return tile;
}

/** Destacar, Teatro e Tela cheia: iguais para lives e para o evento. */
function wireViewControls(tile) {
  const { el, id } = tile;
  el.querySelector('.ctl-focus').addEventListener('click', () => {
    state.focus = id;
    if (state.layoutMode === 'split') setLayout('focus');
    else layout();
  });
  el.querySelector('.ctl-theater').addEventListener('click', () => {
    if (state.layoutMode === 'theater' && mainTileId() === id) {
      setLayout(state.previousLayout && state.previousLayout !== 'theater' ? state.previousLayout : 'focus');
    } else {
      state.focus = id;
      setLayout('theater');
    }
    // Mantém o player à vista depois de trocar o layout
    const frame = el.getBoundingClientRect();
    if (frame.top < 0 || frame.bottom > innerHeight) el.scrollIntoView({ block: 'start' });
  });
  el.querySelector('.ctl-full').addEventListener('click', () => toggleFullscreen(el));
}

function closeClipMenus() {
  for (const menu of document.querySelectorAll('.clip-menu')) menu.hidden = true;
  for (const t of document.querySelectorAll('.tile.clip-open')) t.classList.remove('clip-open');
}

function removeTile(id) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  if (state.popout?.tile === tile) closeDocumentPip();
  if (tile.video && pipElement() === tile.video) exitPip();
  if (state.mini === id) setMiniMode(null);
  if (tile.isEvent) destroyEventPlayer();
  tile.el.remove();
  state.tiles.delete(id);
  if (state.focus === id) state.focus = null;
  layout();
}

// Layout da sala: Teatro (padrão), Em destaque ou Lado a lado. A live principal é a
// destacada (state.focus) ou a primeira que chegou. Os tiles nunca mudam de lugar no
// DOM (mover um <video> pausa a reprodução): o CSS organiza pela classe do palco.
const LAYOUTS = ['theater', 'focus', 'split'];

function mainTileId() {
  if (state.focus && state.tiles.has(state.focus)) return state.focus;
  return state.tiles.keys().next().value ?? null;
}

function setLayout(mode) {
  if (!LAYOUTS.includes(mode)) mode = 'theater';
  if (mode !== state.layoutMode) state.previousLayout = state.layoutMode;
  state.layoutMode = mode;
  layout();
}

function layout() {
  const stage = $('#stage');
  const count = state.tiles.size;
  const mode = LAYOUTS.includes(state.layoutMode) ? state.layoutMode : (state.layoutMode = store.get('layout', 'theater'));
  const main = mainTileId();
  stage.className = `stage ${mode} count-${count === 0 ? '0' : count === 1 ? '1' : 'multi'}`;
  for (const tile of state.tiles.values()) {
    const isMain = tile.id === main;
    tile.el.classList.toggle('is-main', isMain);
    const theater = tile.el.querySelector('.ctl-theater');
    const on = mode === 'theater' && isMain;
    theater.setAttribute('aria-pressed', String(on));
    theater.title = on ? 'Sair do modo Teatro' : 'Modo Teatro';
    // Destacar só faz sentido com mais de uma live e quando ela não é a principal
    tile.el.querySelector('.ctl-focus').hidden = count < 2 || (isMain && mode !== 'split');
    applyQuality(tile);
  }
  // Escolha do layout fica acima dos vídeos quando há mais de uma transmissão
  $('#layout-switch').hidden = count < 2;
  for (const b of $('#layout-switch').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.layout === mode));
  let companion = 0;
  for (const tile of state.tiles.values()) {
    tile.el.classList.toggle('fullscreen-main', tile.id === main);
    tile.el.style.setProperty('--pip-index', tile.id === main ? 0 : companion++);
  }
}

for (const b of $('#layout-switch').querySelectorAll('button')) {
  b.addEventListener('click', () => setLayout(b.dataset.layout));
}

function applyVolume(tile) {
  const mute = tile.el.querySelector('.ctl-mute');
  const silent = tile.muted || tile.volume === 0;
  setIco(mute, silent ? 'mute' : 'volume');
  const label = silent ? `Ativar som de ${tile.name}` : `Silenciar ${tile.name}`;
  mute.title = label;
  mute.setAttribute('aria-label', label);
  tile.audioTrack?.setVolume(tile.muted ? 0 : tile.volume);
}

function applyQuality(tile) {
  if (!tile.publication) return;
  // Ao lado da principal (Em destaque / Teatro), a live vai em qualidade menor para economizar banda
  const minimized = state.tiles.size > 1 && state.layoutMode !== 'split' && mainTileId() !== tile.id;
  const q = minimized || tile.quality === 'low' ? VideoQuality.LOW : VideoQuality.HIGH;
  tile.publication.setVideoQuality(q);
}

function updateResolution(tile, track) {
  const label = tile.el.querySelector('.tile-res');
  const update = () => {
    const h = tile.video.videoHeight;
    label.textContent = h ? `${h}p` : '';
  };
  tile.video.addEventListener('resize', update);
  tile.video.addEventListener('loadedmetadata', update);
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
  const tile = [...state.tiles.values()].find(tile => tile.el === el);
  if (tile) {
    state.focus = tile.id;
    layout();
  }
  // O palco inteiro mantém as outras lives visíveis como miniaturas, sem mover
  // vídeos/iframes no DOM (mover o iframe reinicia o player do evento).
  $('#stage').requestFullscreen?.().catch(() => toast('Não foi possível abrir a tela cheia.', true));
}

let fullscreenIdleTimer;
function wakeFullscreenControls() {
  const stage = $('#stage');
  stage.classList.remove('fullscreen-idle');
  clearTimeout(fullscreenIdleTimer);
  if (document.fullscreenElement === stage) {
    fullscreenIdleTimer = setTimeout(() => stage.classList.add('fullscreen-idle'), 3000);
  }
}
for (const event of ['pointermove', 'pointerdown', 'keydown', 'focusin']) $('#stage').addEventListener(event, wakeFullscreenControls);
document.addEventListener('fullscreenchange', wakeFullscreenControls);

// ---------------- picture-in-picture ----------------
// A live sai numa janela flutuante por cima de tudo (jogo, outras abas).
// O áudio continua tocando pela página, com o volume escolhido no tile.

function pipSupported(video) {
  if (!video) return !!window.documentPictureInPicture?.requestWindow;
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) return true;
  return typeof video.webkitSupportsPresentationMode === 'function'
    && video.webkitSupportsPresentationMode('picture-in-picture');
}

function pipElement() {
  if (document.pictureInPictureElement) return document.pictureInPictureElement;
  for (const tile of state.tiles.values()) {
    if (tile.video?.webkitPresentationMode === 'picture-in-picture') return tile.video;
  }
  return null;
}

async function togglePip(tile) {
  if (state.popout?.tile === tile) return closeDocumentPip();
  if (state.mini === tile.id) return setMiniMode(null);
  if (tile.video && pipElement() === tile.video) return exitPip();
  // App desktop: o WebView2 não tem picture-in-picture, o próprio app vira a janela flutuante
  if (desktop && await setMiniMode(tile.id)) return;
  try {
    if (!tile.video) return await openDocumentPip(tile);
    if (tile.video.requestPictureInPicture) await tile.video.requestPictureInPicture();
    else tile.video.webkitSetPresentationMode('picture-in-picture');
  } catch (err) {
    console.warn('[pip]', err);
    if (state.popout?.tile === tile) closeDocumentPip();
    toast(desktop
      ? 'Atualize o app Faz o L para usar a janela flutuante.'
      : 'Não deu para abrir a janela flutuante. A live já carregou?', true);
  }
}

function closeDocumentPip() {
  const popout = state.popout;
  if (!popout) return;
  state.popout = null;
  if (popout.tile.isEvent) destroyEventPlayer();
  if (state.tiles.get(popout.tile.id) === popout.tile) popout.placeholder.replaceWith(popout.tile.el);
  else popout.placeholder.remove();
  popout.tile.el.querySelector('.ctl-pip')?.classList.remove('active');
  popout.window.close();
  queueMicrotask(() => {
    if (popout.tile.isEvent && state.room && state.tiles.get(popout.tile.id) === popout.tile && ev.data) {
      ensureEventPlayer().then(() => syncEventPlayer(true)).catch(err => toast(err.message, true));
    }
  });
}

async function openDocumentPip(tile) {
  if (!window.documentPictureInPicture?.requestWindow) {
    return toast('Para abrir o evento em janela flutuante, use Chrome, Edge ou o app Windows.', true);
  }
  closeDocumentPip();
  // Precisa acontecer no clique para preservar a autorização do navegador.
  const pipWindow = await window.documentPictureInPicture.requestWindow({ width: 640, height: 420 });
  if (document.fullscreenElement) await document.exitFullscreen();
  const doc = pipWindow.document;
  doc.documentElement.dataset.theme = document.documentElement.dataset.theme || '';
  doc.documentElement.lang = 'pt-BR';
  doc.title = tile.name;
  const base = doc.createElement('base');
  base.href = document.baseURI;
  const stylesheet = doc.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('/style.css', document.baseURI).href;
  doc.head.append(base, stylesheet);
  doc.body.className = 'document-pip';
  const placeholder = document.createElement('div');
  placeholder.className = 'player pip-placeholder';
  const label = document.createElement('span');
  label.textContent = 'O evento está na janela flutuante';
  const back = makeButton('Voltar para a sala', 'room');
  back.addEventListener('click', closeDocumentPip);
  placeholder.append(label, back);
  tile.el.before(placeholder);
  // Iframes entre documentos precisam ser recriados; voltam ao tempo sincronizado.
  if (tile.isEvent) destroyEventPlayer();
  doc.body.append(tile.el);
  state.popout = { tile, window: pipWindow, placeholder };
  tile.el.querySelector('.ctl-pip').classList.add('active');
  pipWindow.addEventListener('pagehide', () => {
    if (state.popout?.window === pipWindow) closeDocumentPip();
  }, { once: true });
  if (tile.isEvent) await ensureEventPlayer();
  syncEventPlayer(true);
}

/** Modo mini do app desktop: id do tile que vira a janela flutuante, ou null para voltar. */
async function setMiniMode(id) {
  const prev = state.mini ? state.tiles.get(state.mini) : null;
  try {
    await desktop.core.invoke('set_mini_mode', { on: Boolean(id) });
  } catch (err) {
    console.warn('[mini]', err); // app antigo, sem o comando
    if (id) return false;
  }
  if (prev) {
    prev.el.classList.remove('mini-target');
    prev.el.querySelector('.ctl-pip').classList.remove('active');
  }
  state.mini = id || null;
  document.body.classList.toggle('mini-mode', Boolean(id));
  const tile = id && state.tiles.get(id);
  if (tile) {
    tile.el.classList.add('mini-target');
    tile.el.querySelector('.ctl-pip').classList.add('active');
  }
  return true;
}

function exitPip() {
  closeDocumentPip();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  for (const tile of state.tiles.values()) {
    if (tile.video?.webkitPresentationMode === 'picture-in-picture') tile.video.webkitSetPresentationMode('inline');
  }
}

function setPipState(tile, on) {
  tile.el.classList.toggle('in-pip', on);
  tile.el.querySelector('.tile-pip-note').hidden = !on;
  tile.el.querySelector('.ctl-pip').classList.toggle('active', on);
}

// Chrome: abre a janela flutuante sozinho ao trocar de aba, se o navegador permitir
try {
  navigator.mediaSession?.setActionHandler('enterpictureinpicture', () => {
    const tile = (state.focus && state.tiles.get(state.focus))
      || [...state.tiles.values()].find((t) => !t.isLocal);
    if (tile) togglePip(tile);
  });
} catch { /* navegador não suporta */ }

// ---------------- presença / contadores ----------------

// Uma pessoa pode estar na sala com mais de um participante:
//   "<id>"      navegador
//   "<id>:app"  a página dentro do app desktop
//   "<id>:tela" a transmissão nativa do app desktop
// Na lista ela aparece uma vez só (marcada AO VIVO se qualquer um transmite).
const DESKTOP_SUFFIX = ':tela';
const ownerOf = (identity) => identity.replace(/:(tela|app)$/, '');

function allParticipants() {
  if (!state.room) return [];
  return [state.room.localParticipant, ...state.room.remoteParticipants.values()];
}

function participants() {
  const byOwner = new Map();
  for (const p of allParticipants()) {
    const owner = ownerOf(p.identity);
    const current = byOwner.get(owner);
    // Prefere: eu mesmo > quem não é a transmissão nativa
    if (!current || p === state.room.localParticipant || (current.identity.endsWith(DESKTOP_SUFFIX) && current !== state.room.localParticipant)) {
      byOwner.set(owner, p);
    }
  }
  return [...byOwner.values()];
}

function hasScreen(p) {
  if (!p) return false;
  for (const pub of p.trackPublications.values()) if (pub.source === Track.Source.ScreenShare) return true;
  return false;
}

/** Minha transmissão pelo app desktop (participante "<eu>:tela"), se estiver no ar. */
function myAppStream() {
  const p = state.me && state.room?.remoteParticipants.get(state.me.id + DESKTOP_SUFFIX);
  return p && hasScreen(p) ? p : null;
}

function isStreaming(p) {
  const owner = ownerOf(p.identity);
  if (owner === state.me?.id && state.local) return true;
  return allParticipants().some((x) => x !== state.room.localParticipant && ownerOf(x.identity) === owner && hasScreen(x));
}

function renderPresence() {
  if (!state.room) return;
  const all = participants();
  const streamers = all.filter(isStreaming);
  const viewers = all.length - streamers.length;
  const { maxStreamers, maxViewers } = state.limits;

  $('#live-count').textContent = `${streamers.length}/${maxStreamers} ao vivo`;
  $('#pill-live').classList.toggle('on', streamers.length > 0);
  $('#nav-live').hidden = streamers.length === 0;
  $('#viewer-count').textContent = `${viewers}/${maxViewers} espectadores`;
  $('#people-count').textContent = `${all.length} ${all.length === 1 ? 'pessoa' : 'pessoas'}`;

  // Diálogo Transmitir: vagas e estado do botão
  const free = maxStreamers - streamers.length;
  const btn = $('#btn-stream');
  const full = !state.local && !myAppStream() && free <= 0;
  $('#broadcast-full').hidden = !full;
  $('#broadcast-full-text').textContent = `As ${maxStreamers} vagas de transmissão estão ocupadas. Quando uma live terminar, você pode começar a sua.`;
  if (state.local) {
    $('#btn-stream-text').textContent = 'Você está ao vivo';
    btn.disabled = true;
    $('#slots').textContent = 'Para encerrar, use Encerrar live no topo da sala.';
  } else if (myAppStream()) {
    // Transmitindo pelo app desktop e assistindo aqui no navegador
    $('#btn-stream-text').textContent = 'Transmitindo pelo app';
    btn.disabled = true;
    $('#slots').textContent = 'Você está ao vivo pelo app. Pare a transmissão por lá.';
  } else {
    $('#btn-stream-text').textContent = state.busy ? 'Começando…' : desktop ? 'Começar live' : 'Escolher tela';
    btn.disabled = state.busy || free <= 0;
    $('#slots').textContent = free > 0
      ? `${free} de ${maxStreamers} vaga${maxStreamers > 1 ? 's' : ''} livre${free > 1 ? 's' : ''} para transmitir.`
      : '';
  }
  renderRoomActions();

  // Pessoas na sala: quem transmite primeiro; o nome abre o perfil
  const list = $('#people');
  list.replaceChildren(
    ...all
      .sort((a, b) => Number(isStreaming(b)) - Number(isStreaming(a)))
      .map((p) => {
        const li = document.createElement('li');
        const name = p.name || p.identity;
        const username = usernameOf(p);
        const row = document.createElement(username ? 'a' : 'div');
        row.className = 'person';
        if (username) {
          row.href = profileHref(username);
          row.dataset.link = '';
          row.title = `Perfil de ${name}`;
        }
        const label = document.createElement('strong');
        label.textContent = name;
        const status = document.createElement('small');
        const live = isStreaming(p);
        status.textContent = live ? 'Ao vivo' : p === state.room.localParticipant ? 'Você' : 'Assistindo';
        if (live) status.className = 'live-text';
        row.append(makeAvatar(name, avatarOf(p)), label, status);
        li.append(row);
        return li;
      }),
  );
}

// ---------------- transmitir ----------------

$('#opt-quality').value = store.get('stream-quality', '1080p30');
$('#opt-content').value = store.get('stream-content', 'motion');
$('#opt-audio').checked = store.get('stream-audio', '1') === '1';
$('#opt-quality').addEventListener('change', (e) => store.set('stream-quality', e.target.value));
$('#opt-content').addEventListener('change', (e) => store.set('stream-content', e.target.value));
$('#broadcast-source').replaceChildren(ico('room'), 'Transmitindo pelo navegador');

function waitForPublishPermission(timeoutMs = 6000) {
  const lp = state.room.localParticipant;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (lp.permissions?.canPublish) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('O servidor demorou para liberar a transmissão.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function startStream() {
  if (state.busy || state.local || !state.room) return;
  if (desktop) return startNativeStream();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Seu navegador não suporta transmitir a tela. Use Chrome, Edge ou Firefox no computador.', true);
    return;
  }

  const q = QUALITY[$('#opt-quality').value] || QUALITY['1080p30'];
  const content = $('#opt-content').value;
  const withAudio = $('#opt-audio').checked;

  state.busy = true;
  renderPresence();

  // 1) Captura primeiro (o navegador exige que seja logo após o clique)
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: q.width },
        height: { ideal: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      },
      audio: withAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
            suppressLocalAudioPlayback: false,
            restrictOwnAudio: true, // não captura o som das outras lives tocando nesta aba
          }
        : false,
      systemAudio: withAudio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch {
    state.busy = false;
    renderPresence();
    return; // usuário cancelou
  }

  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0] || null;
  video.contentHint = content === 'detail' ? 'detail' : 'motion';

  try {
    // 2) Pede uma vaga ao servidor
    await api(ch('/stream/start'), { method: 'POST' });
    await waitForPublishPermission();

    // 3) Publica
    const lp = state.room.localParticipant;
    const encoding = { maxBitrate: q.bitrate, maxFramerate: q.fps };
    const layers = [new VideoPreset(...q.layer)];
    await lp.publishTrack(video, {
      source: Track.Source.ScreenShare,
      name: 'screen',
      stream: 'screen',
      videoCodec: 'h264', // codificação por hardware na maioria das GPUs = menos atraso
      simulcast: true,
      videoEncoding: encoding,
      screenShareEncoding: encoding,
      videoSimulcastLayers: layers,
      screenShareSimulcastLayers: layers,
      degradationPreference: content === 'detail' ? 'maintain-resolution' : 'maintain-framerate',
    });
    if (audio) {
      await lp.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
        name: 'screen-audio',
        stream: 'screen',
        audioPreset: AudioPresets.musicHighQualityStereo,
        forceStereo: true,
        dtx: false,
        red: false,
      });
    } else if (withAudio) {
      toast('Transmitindo sem som: marque "Compartilhar áudio" na janela do navegador.');
    }

    state.local = { video, audio };
    video.addEventListener('ended', stopStream);

    const tile = ensureTile('__local__', state.me.name, true);
    tile.video.srcObject = new MediaStream([video]);
    tile.el.classList.add('has-video');
    updateResolution(tile);
    $('#dlg-broadcast').close();
    state.focus = '__local__';
    layout();
    toast('Você está ao vivo.');
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await unpublishScreen();
    await api(ch('/stream/stop'), { method: 'POST' }).catch(() => {});
    toast(err.message || 'Não foi possível transmitir.', true);
  } finally {
    state.busy = false;
    renderPresence();
  }
}

async function unpublishScreen() {
  const lp = state.room?.localParticipant;
  if (!lp) return;
  for (const pub of [...lp.trackPublications.values()]) {
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      if (pub.track) await lp.unpublishTrack(pub.track, true).catch(() => {});
    }
  }
}

function cleanupLocal() {
  if (!state.local) return false;
  state.local.video?.stop();
  state.local.audio?.stop();
  state.local = null;
  removeTile('__local__');
  return true;
}

async function stopStream() {
  const wasNative = !!state.local?.native;
  if (!cleanupLocal()) return;
  if (wasNative) {
    await desktop.core.invoke('stop_stream').catch(() => {});
    await api(ch('/desktop/stop'), { method: 'POST' }).catch(() => {});
  } else {
    await unpublishScreen();
    if (state.room) await api(ch('/stream/stop'), { method: 'POST' }).catch(() => {});
  }
  renderPresence();
}

// ---------------- clipes ----------------

document.addEventListener('click', (e) => {
  if (!e.target.closest('.clip-menu')) closeClipMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.clip-menu:not([hidden])')) closeClipMenus();
});

let clipsTimer = null;
const lengthLabel = (seconds) => {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m ? (s ? `${m} min ${s} s` : `${m} min`) : `${s} s`;
};

async function createClip(streamer, seconds, tile = null) {
  toast(`Gerando clipe dos últimos ${lengthLabel(seconds)}…`);
  try {
    const clip = await api(ch('/clips'), { method: 'POST', body: { streamer, seconds } });
    loadClips();
    openClipDialog(clip, tile);
    return clip;
  } catch (err) {
    toast(err.message, true);
  }
}

// Depois de clipar: título e descrição (opcionais). Publicar/Pular manda o link pro Discord.
let editingClip = null;
function openClipDialog(clip, tile = null) {
  editingClip = clip;
  $('#clip-dialog-title').textContent = 'Clipe pronto';
  $('#clip-submit').querySelector('span').textContent = 'Publicar';
  $('#clip-skip').textContent = 'Pular';
  const from = tile?.name || clip.streamer?.name;
  $('#clip-dialog-source').textContent = `${from ? `Live de ${from} · ` : ''}${lengthLabel(clip.seconds)}`;
  $('#clip-preview').src = clip.url;
  $('#clip-title').value = clip.title || '';
  $('#clip-description').value = clip.description || '';
  channelMembers(); // já carrega a lista pro @
  $('#dlg-clip').showModal();
  setTimeout(() => $('#clip-title').focus(), 50);
}

async function finishClipDialog(withDetails) {
  const clip = editingClip;
  editingClip = null;
  $('#dlg-clip').close();
  $('#clip-preview').removeAttribute('src');
  hideMentionBox();
  if (!clip) return;
  const body = { publish: true };
  if (withDetails) {
    body.title = $('#clip-title').value;
    body.description = $('#clip-description').value;
  }
  try {
    const saved = await api(`/api/clips/${clip.id}`, { method: 'PATCH', body });
    const tagged = saved.mentions.length ? ` ${saved.mentions.length} ${saved.mentions.length === 1 ? 'pessoa marcada' : 'pessoas marcadas'}.` : '';
    toast(`Clipe publicado.${tagged}`);
    loadClips();
  } catch (err) {
    toast(err.message, true);
  }
}
$('#form-clip').addEventListener('submit', (e) => {
  e.preventDefault();
  if (editDone) saveEdit();
  else finishClipDialog(true);
});
$('#clip-skip').addEventListener('click', () => (editDone ? $('#dlg-clip').close() : finishClipDialog(false)));
$('#dlg-clip').addEventListener('cancel', (e) => {
  e.preventDefault();
  if (!$('#mention-box').hidden) return hideMentionBox();
  if (editDone) return $('#dlg-clip').close();
  finishClipDialog(false);
});

function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

function timeLeft(expiresAt) {
  const h = Math.max(0, (expiresAt - Date.now()) / 3600000);
  return h >= 1 ? `some em ${Math.floor(h)} h` : `some em ${Math.max(1, Math.round(h * 60))} min`;
}

const timestamp = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

async function loadClips() {
  if (!state.me || !state.channel) return;
  const channelId = state.channel.id;
  try {
    const { clips } = await api(ch('/clips'));
    if (state.channel?.id !== channelId) return;
    clipsView.clips = clips;
    renderClipsPanel(clips);
    renderClipShelf();
    if (!$('#view-clips').hidden) renderClipsPage();
  } catch (err) {
    console.warn('[clipes]', err); // sem clipes por enquanto
  }
}

/** Texto com os @ marcados virando link pro perfil. */
function withMentions(text, mentions) {
  const known = new Map(mentions.map((u) => [u.username?.toLowerCase(), u]));
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(/@([a-z0-9_.]{2,32})/gi)) {
    const username = m[1].replace(/\.+$/, '');
    const user = known.get(username.toLowerCase());
    if (!user) continue;
    frag.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.className = 'mention';
    a.href = profileHref(user.username);
    a.dataset.link = '';
    a.title = user.name;
    a.textContent = `@${username}`;
    frag.append(a);
    last = m.index + 1 + username.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function personLink(person) {
  if (!person.username) return document.createTextNode(person.name);
  const a = document.createElement('a');
  a.className = 'person-link';
  a.href = profileHref(person.username);
  a.dataset.link = '';
  a.textContent = person.name;
  return a;
}

const clipName = (clip) => clip.title || `Live de ${clip.streamer.name}`;
const clipHref = (clip) => `/c/${clip.channel?.id || state.channel?.id}/clipes/${clip.id}`;

/** Card da biblioteca: miniatura (primeiro quadro), duração, título e autoria. */
function clipCard(clip, { showChannel = false } = {}) {
  const a = document.createElement('a');
  a.className = 'clip-card';
  a.href = clipHref(clip);
  a.dataset.link = '';
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const video = document.createElement('video');
  video.src = `${clip.url}#t=0.5`;
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  const len = document.createElement('span');
  len.className = 'duration';
  len.textContent = timestamp(clip.seconds);
  thumb.append(video, len);
  if (clip.saved) {
    const badge = document.createElement('span');
    badge.className = 'saved-badge';
    badge.title = 'Salvo';
    badge.append(ico('bookmark'));
    thumb.append(badge);
  }
  const info = document.createElement('span');
  info.className = 'clip-info';
  const title = document.createElement('strong');
  title.textContent = clipName(clip);
  const meta = document.createElement('small');
  const parts = [clip.streamer.name, timeAgo(clip.createdAt)];
  if (showChannel && clip.channel) parts.push(clip.channel.name);
  meta.textContent = parts.join(' · ');
  info.append(title, meta);
  a.append(thumb, info);
  return a;
}

/** Contador de clipes no item Clipes da barra lateral. */
function renderClipsPanel(clips) {
  $('#clips-count').textContent = clips.length ? String(clips.length) : '';
}

/** Clipes recentes abaixo da sala. */
function renderClipShelf() {
  const recent = clipsView.clips.slice(0, 3);
  $('#clip-shelf').hidden = !recent.length;
  $('#shelf-grid').replaceChildren(...recent.map((c) => clipCard(c)));
}

// ---------------- biblioteca de clipes (tela própria) ----------------

const clipsView = { clips: [], selected: null, filter: 'all' };

function filteredClips() {
  const { clips, filter } = clipsView;
  if (filter === 'mine') return clips.filter((c) => c.mine);
  if (filter === 'saved') return clips.filter((c) => c.saved);
  return clips;
}

async function showClipsPage(channelId, clipId) {
  if (!(await loadChannel(channelId))) return;
  clipsView.selected = clipId;
  document.title = `Clipes • ${state.channel.name} • Faz o L`;
  show('view-clips');
  $('#clips-channel').textContent = state.channel.name;
  $('#clip-back').href = `/c/${channelId}/clipes`;
  renderClipsPage();
  if (!clipsView.clips.length) loadClips();
}

function renderClipsPage() {
  const detail = clipsView.selected;
  $('#clips-list-view').hidden = !!detail;
  $('#clip-detail').hidden = !detail;
  if (detail) return renderClipDetail();
  $('#clip-player').pause();
  for (const b of $('#clips-filter').children) b.setAttribute('aria-pressed', String(b.dataset.filter === clipsView.filter));
  const clips = filteredClips();
  $('#clips-grid').replaceChildren(...clips.map((c) => clipCard(c)));
  $('#clips-grid').hidden = !clips.length;
  $('#clips-empty').hidden = clips.length > 0;
  $('#clips-empty-text').textContent = {
    all: 'Clipe um momento de uma live e ele aparece aqui. Clipes não salvos somem em 24 h.',
    mine: 'Os clipes que você fizer aparecem aqui.',
    saved: 'Salve um clipe para ele não sumir em 24 h.',
  }[clipsView.filter];
}

$('#clips-filter').addEventListener('click', (e) => {
  const filter = e.target.closest('button')?.dataset.filter;
  if (!filter) return;
  clipsView.filter = filter;
  renderClipsPage();
});

/** Detalhe: reprodução, autoria, descrição, menções e ações. */
function renderClipDetail() {
  const clip = clipsView.clips.find((c) => c.id === clipsView.selected);
  const player = $('#clip-player');
  if (!clip) {
    player.removeAttribute('src');
    $('#clip-detail-title').textContent = clipsView.clips.length ? 'Clipe indisponível' : 'Carregando…';
    $('#clip-detail-meta').textContent = clipsView.clips.length ? 'Este clipe pode ter sido removido ou expirado (clipes não salvos somem em 24 h).' : '';
    for (const id of ['#clip-detail-desc', '#clip-detail-tags']) $(id).hidden = true;
    $('#clip-detail-actions').replaceChildren();
    $('#clip-detail-expiry').textContent = '';
    return;
  }
  document.title = `${clipName(clip)} • Faz o L`;
  if (player.dataset.clip !== clip.id) {
    player.dataset.clip = clip.id;
    player.src = clip.url;
    player.play().catch(() => {});
  }
  const title = $('#clip-detail-title');
  title.replaceChildren();
  if (clip.title) title.append(withMentions(clip.title, clip.mentions));
  else title.append('Live de ', personLink(clip.streamer));

  const meta = $('#clip-detail-meta');
  meta.replaceChildren('Live de ', personLink(clip.streamer), ` · ${lengthLabel(clip.seconds)} · por `, personLink(clip.creator), ` · ${timeAgo(clip.createdAt)}`);

  const desc = $('#clip-detail-desc');
  desc.hidden = !clip.description;
  desc.replaceChildren();
  if (clip.description) desc.append(withMentions(clip.description, clip.mentions));

  const tags = $('#clip-detail-tags');
  tags.hidden = !clip.mentions.length;
  tags.replaceChildren(...clip.mentions.filter((u) => u.username).map((u) => {
    const a = document.createElement('a');
    a.className = 'button ghost';
    a.href = profileHref(u.username);
    a.dataset.link = '';
    a.title = `Perfil de ${u.name}`;
    a.textContent = `@${u.username}`;
    return a;
  }));

  $('#clip-detail-actions').replaceChildren(...clipActions(clip, { onChange: loadClips }));
  $('#clip-detail-expiry').textContent = clip.saved
    ? (clip.savedBy ? `Salvo por ${clip.savedBy}. Não expira.` : 'Salvo. Não expira.')
    : `Clipes não salvos expiram em 24 h: este ${timeLeft(clip.expiresAt)}.`;
}

/** Copiar link, baixar, editar, salvar e excluir. */
function clipActions(clip, { onChange, afterDelete } = {}) {
  const actions = [];
  const link = `${location.origin}${clip.page}`;

  const copy = makeButton('Copiar link', 'link');
  copy.addEventListener('click', () => copyText(link, 'Link copiado. Cole no Discord.'));
  actions.push(copy);

  const download = document.createElement('a');
  download.className = 'button';
  download.append(ico('download'), 'Baixar');
  download.href = clip.url;
  download.download = `faz-o-l-${clip.id}.${clip.mime.includes('mp4') ? 'mp4' : 'webm'}`;
  actions.push(download);

  if (clip.mine) {
    const edit = makeButton('Editar', 'settings');
    edit.title = 'Título, descrição e marcações';
    edit.addEventListener('click', () => openEditDialog(clip, onChange));
    actions.push(edit);
  }
  // Salvar: qualquer pessoa do canal. Tirar dos salvos: quem salvou, quem clipou ou o dono.
  if (clip.canSave ?? clip.mine) {
    const save = makeButton(clip.saved ? 'Salvo' : 'Salvar', 'bookmark', clip.saved ? 'saved' : '');
    const savedBy = clip.savedBy ? `Salvo por ${clip.savedBy}` : 'Salvo';
    save.disabled = clip.saved && clip.canUnsave === false;
    save.title = !clip.saved ? 'Guardar pra sempre (senão expira em 24 h)'
      : save.disabled ? savedBy : `${savedBy}. Clique pra deixar expirar em 24 h`;
    save.addEventListener('click', async () => {
      try {
        await api(`/api/clips/${clip.id}`, { method: 'PATCH', body: { saved: !clip.saved } });
        toast(clip.saved ? 'Clipe removido dos salvos.' : 'Clipe salvo.');
        onChange?.();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.push(save);
  }
  if (clip.canDelete) {
    const del = makeButton('Excluir', 'trash', 'danger');
    del.addEventListener('click', async () => {
      const ok = await confirmAction('Excluir clipe?', `“${clipName(clip)}” será removido da biblioteca do canal. Não dá pra desfazer.`, 'Excluir clipe');
      if (!ok) return;
      try {
        await api(`/api/clips/${clip.id}`, { method: 'DELETE' });
        toast('Clipe excluído.');
        if (afterDelete) afterDelete();
        else {
          await loadClips();
          navigate(`/c/${state.channel.id}/clipes`, { replace: true });
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.push(del);
  }
  return actions;
}

// Editar um clipe já publicado (o Discord não recebe de novo)
let editDone = null;
function openEditDialog(clip, onChange) {
  editingClip = null;
  editDone = { clip, onChange };
  // No perfil, o clipe pode ser de outro canal: o @ sugere os membros de lá
  state.mentionChannel = clip.channel && clip.channel.id !== state.channel?.id ? clip.channel.id : null;
  $('#clip-dialog-title').textContent = 'Editar clipe';
  $('#clip-dialog-source').textContent = `Live de ${clip.streamer.name} · ${lengthLabel(clip.seconds)}`;
  $('#clip-submit').querySelector('span').textContent = 'Salvar';
  $('#clip-skip').textContent = 'Cancelar';
  $('#clip-preview').src = clip.url;
  $('#clip-title').value = clip.title || '';
  $('#clip-description').value = clip.description || '';
  $('#dlg-clip').showModal();
}
async function saveEdit() {
  const { clip, onChange } = editDone;
  editDone = null;
  $('#dlg-clip').close();
  try {
    await api(`/api/clips/${clip.id}`, {
      method: 'PATCH',
      body: { title: $('#clip-title').value, description: $('#clip-description').value },
    });
    toast('Clipe atualizado.');
    onChange?.();
  } catch (err) {
    toast(err.message, true);
  }
}
$('#dlg-clip').addEventListener('close', () => {
  editDone = null;
  state.mentionChannel = null;
  $('#clip-preview').pause();
  hideMentionBox();
});

function startClipsRefresh() {
  loadClips();
  clearInterval(clipsTimer);
  clipsTimer = setInterval(loadClips, 30_000);
}

// ---------------- autocompletar @ ----------------

const mentionState = { field: null, start: 0, items: [], active: 0 };

async function mentionCandidates() {
  const channelId = state.mentionChannel || state.channel?.id;
  if (!channelId) return [];
  if (state.mentionChannel) {
    try {
      return (await api(`/api/c/${channelId}/members`)).members;
    } catch {
      return [];
    }
  }
  return channelMembers();
}

function hideMentionBox() {
  $('#mention-box').hidden = true;
  mentionState.field = null;
}

function pickMention(user) {
  const field = mentionState.field;
  if (!field || !user) return;
  const caret = field.selectionStart;
  const before = field.value.slice(0, mentionState.start);
  const after = field.value.slice(caret);
  const insert = `@${user.username} `;
  field.value = (before + insert + after).slice(0, field.maxLength > 0 ? field.maxLength : undefined);
  const pos = before.length + insert.length;
  field.setSelectionRange(pos, pos);
  field.focus();
  hideMentionBox();
}

function renderMentionBox() {
  const box = $('#mention-box');
  const { items, active, field } = mentionState;
  if (!field || !items.length) return hideMentionBox();
  box.replaceChildren(
    ...items.map((u, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === active ? 'active' : '';
      if (u.avatar) {
        const img = document.createElement('img');
        img.src = u.avatar;
        img.alt = '';
        b.append(img);
      }
      const name = document.createElement('span');
      name.textContent = u.name;
      const handle = document.createElement('span');
      handle.className = 'muted';
      handle.textContent = `@${u.username}`;
      b.append(name, handle);
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickMention(u);
      });
      return b;
    }),
  );
  // dentro de um <dialog> modal a lista precisa estar no próprio dialog (top layer), senão fica atrás
  const host = field.closest('dialog') || document.body;
  if (box.parentElement !== host) host.append(box);
  const rect = field.getBoundingClientRect();
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.bottom + 4}px`;
  box.style.width = `${Math.min(rect.width, 320)}px`;
  box.hidden = false;
}

async function onMentionInput(e) {
  const field = e.target;
  const upto = field.value.slice(0, field.selectionStart);
  const m = upto.match(/(?:^|\s)@([a-z0-9_.]{0,32})$/i);
  if (!m) return hideMentionBox();
  const query = m[1].toLowerCase();
  if (mentionState.field !== field) state.members = null; // recarrega membros novos a cada abertura
  const members = await mentionCandidates();
  mentionState.field = field;
  mentionState.start = upto.length - m[1].length - 1;
  mentionState.items = members
    .filter((u) => u.username && (u.username.toLowerCase().includes(query) || u.name.toLowerCase().includes(query)))
    .slice(0, 8);
  mentionState.active = 0;
  renderMentionBox();
}

function onMentionKey(e) {
  if ($('#mention-box').hidden || mentionState.field !== e.target) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = mentionState.items.length;
    mentionState.active = (mentionState.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderMentionBox();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickMention(mentionState.items[mentionState.active]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideMentionBox();
  }
}

for (const field of [$('#clip-title'), $('#clip-description')]) {
  field.addEventListener('input', onMentionInput);
  field.addEventListener('keydown', onMentionKey);
  field.addEventListener('blur', () => setTimeout(hideMentionBox, 150));
}

// ---------------- perfil ----------------

let profileData = null;
let profileTab = 'streamed';

async function showProfile(username) {
  state.profileUser = username;
  show('view-profile');
  $('#profile-name').textContent = 'Carregando…';
  $('#profile-username').textContent = `@${username}`;
  $('#profile-channels').textContent = '';
  $('#btn-logout-profile').hidden = username !== state.me.username;
  fillMark($('#profile-avatar'), username, '');
  $('#profile-clips').replaceChildren();
  $('#profile-empty').hidden = true;
  try {
    profileData = await api(`/api/users/${encodeURIComponent(username)}`);
  } catch (err) {
    $('#profile-name').textContent = 'Perfil indisponível';
    $('#profile-channels').textContent = err.message;
    return;
  }
  const { user, channels } = profileData;
  document.title = `${user.name} • Faz o L`;
  $('#profile-name').textContent = user.name;
  fillMark($('#profile-avatar'), user.name, user.avatar);
  $('#profile-channels').textContent = channels.length ? `Canais em comum: ${channels.map((c) => c.name).join(', ')}` : '';
  $('#count-streamed').textContent = `(${profileData.streamed.length})`;
  $('#count-tagged').textContent = `(${profileData.tagged.length})`;
  renderProfileTab();
}

function renderProfileTab() {
  for (const tab of $('#profile-tabs').children) tab.setAttribute('aria-pressed', String(tab.dataset.tab === profileTab));
  const me = profileData.me;
  const clips = profileData[profileTab];
  $('#profile-empty-text').textContent = profileTab === 'streamed'
    ? (me ? 'Ninguém clipou suas lives ainda.' : 'Ninguém clipou as lives dessa pessoa ainda.')
    : (me ? 'Ninguém te marcou em clipes ainda.' : 'Essa pessoa ainda não foi marcada em clipes.');
  $('#profile-empty').hidden = clips.length > 0;
  $('#profile-clips').hidden = !clips.length;
  $('#profile-clips').replaceChildren(...clips.map((c) => clipCard(c, { showChannel: true })));
}

$('#profile-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (!tab) return;
  profileTab = tab;
  if (profileData) renderProfileTab();
});

// ---------------- configurações (um único lugar) ----------------
// A engrenagem abre o mesmo painel em qualquer tela e lembra a última seção.

const SETTINGS_SECTIONS = ['appearance', 'watch', 'broadcast', 'clips', 'desktop', 'channel'];
let settingsSection = 'appearance';

function openSettings(section = settingsSection) {
  showSettingsSection(section);
  const dlg = $('#dlg-settings');
  if (!dlg.open) dlg.showModal();
}

function showSettingsSection(section) {
  if (!SETTINGS_SECTIONS.includes(section)) section = 'appearance';
  if (section === 'channel' && !state.channel) section = 'appearance';
  settingsSection = section;
  for (const b of document.querySelectorAll('.settings-nav [data-section]')) {
    if (b.dataset.section === section) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const s of document.querySelectorAll('.settings-content > [data-section]')) s.classList.toggle('active', s.dataset.section === section);
  $('.settings-content').scrollTop = 0;
  ({
    appearance: () => { $('#set-theme').value = store.get('theme', 'dark'); },
    watch: () => {
      $('#set-layout').value = store.get('layout', 'theater');
      $('#set-watch-quality').value = store.get('quality', 'high');
    },
    broadcast: () => {
      $('#set-stream-quality').replaceChildren(...[...$('#opt-quality').options].map((o) => new Option(o.textContent, o.value)));
      $('#set-stream-quality').value = $('#opt-quality').value;
      $('#set-stream-content').value = $('#opt-content').value;
      $('#set-stream-audio').checked = store.get('stream-audio', '1') === '1';
    },
    clips: () => renderClipSettings(),
    desktop: () => renderClipSettings(),
    channel: () => openManage(),
  })[section]();
}

$('#btn-settings').addEventListener('click', () => openSettings());
$('#settings-close').addEventListener('click', () => $('#dlg-settings').close());
$('#settings-done').addEventListener('click', () => $('#dlg-settings').close());
$('.settings-nav').addEventListener('click', (e) => {
  const section = e.target.closest('[data-section]')?.dataset.section;
  if (section) showSettingsSection(section);
});

$('#set-theme').addEventListener('change', (e) => {
  store.set('theme', e.target.value);
  applyTheme();
  toast('Tema salvo.');
});
$('#set-layout').addEventListener('change', (e) => {
  store.set('layout', e.target.value);
  if (state.room) setLayout(e.target.value);
  toast('Layout padrão salvo.');
});
$('#set-watch-quality').addEventListener('change', (e) => {
  store.set('quality', e.target.value);
  for (const tile of state.tiles.values()) {
    if (tile.isLocal || tile.isEvent) continue;
    tile.quality = e.target.value;
    tile.el.querySelector('.ctl-quality').value = tile.quality;
    applyQuality(tile);
  }
  toast('Qualidade ao assistir salva.');
});
$('#set-stream-quality').addEventListener('change', (e) => {
  $('#opt-quality').value = e.target.value;
  $('#opt-quality').dispatchEvent(new Event('change'));
  toast('Qualidade padrão salva.');
});
$('#set-stream-content').addEventListener('change', (e) => {
  $('#opt-content').value = e.target.value;
  $('#opt-content').dispatchEvent(new Event('change'));
  toast('Tipo de conteúdo salvo.');
});
$('#set-stream-audio').addEventListener('change', (e) => {
  store.set('stream-audio', e.target.checked ? '1' : '0');
  $('#opt-audio').checked = e.target.checked;
  toast('Áudio padrão salvo.');
});

// ---------------- canal: convites, avisos e membros ----------------

async function openManage() {
  const c = state.channel;
  if (!c) return;
  const owner = c.role === 'owner';
  $('#manage-name').textContent = c.name;
  $('#manage-role').textContent = owner ? 'Você é dono deste canal.' : 'O dono do canal gerencia convites, avisos e membros.';
  $('#manage-owner').hidden = !owner;
  if (owner) {
    loadInvites();
    loadDiscordChannels();
  }
  loadMembers();
}

async function loadInvites() {
  try {
    const { invites } = await api(ch('/invites'));
    const list = $('#invite-list');
    if (!invites.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nenhum convite ativo.';
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(
      ...invites.map((inv) => {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.className = 'grow';
        const expires = inv.expiresAt ? `expira ${new Date(inv.expiresAt).toLocaleDateString('pt-BR')}` : 'não expira';
        const uses = inv.maxUses ? `${inv.uses}/${inv.maxUses} usos` : `${inv.uses} usos`;
        text.textContent = `${inv.url.replace(/^https?:\/\//, '')} · ${expires} · ${uses}`;
        text.title = inv.url;
        const actions = document.createElement('div');
        actions.className = 'button-row';
        const copy = makeIconButton('Copiar convite', 'link', '');
        copy.addEventListener('click', () => copyText(inv.url, 'Link de convite copiado.'));
        const revoke = makeIconButton('Revogar convite', 'trash', '');
        revoke.addEventListener('click', async () => {
          if (!(await confirmAction('Revogar convite?', `O acesso pelo link ${inv.url.replace(/^https?:\/\//, '')} será desativado.`, 'Revogar convite'))) return;
          await api(ch(`/invites/${inv.code}`), { method: 'DELETE' }).then(() => toast('Convite revogado.'), (err) => toast(err.message, true));
          loadInvites();
        });
        actions.append(copy, revoke);
        li.append(text, actions);
        return li;
      }),
    );
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-invite').addEventListener('click', async () => {
  try {
    const invite = await api(ch('/invites'), {
      method: 'POST',
      body: { days: Number($('#invite-days').value), maxUses: Number($('#invite-uses').value) || null },
    });
    await navigator.clipboard.writeText(invite.url).then(
      () => toast('Convite criado e copiado. Cole no Discord.'),
      () => toast('Convite criado.'),
    );
    loadInvites();
  } catch (err) {
    toast(err.message, true);
  }
});

async function loadMembers() {
  state.members = null;
  const members = await channelMembers();
  const owner = state.channel?.role === 'owner';
  $('#members-count').textContent = `(${members.length})`;
  $('#member-list').replaceChildren(
    ...members.map((m) => {
      const li = document.createElement('li');
      const who = document.createElement('div');
      who.className = 'identity';
      const text = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = m.name;
      const handle = document.createElement('small');
      handle.textContent = `${m.username ? `@${m.username}` : 'convidado'}${m.role === 'owner' ? ' · Dono' : ''}`;
      text.append(name, handle);
      who.append(makeAvatar(m.name, m.avatar), text);
      li.append(who);
      if (owner && m.role !== 'owner') {
        const remove = makeButton('Remover', '', 'ghost');
        remove.addEventListener('click', async () => {
          if (!(await confirmAction(`Remover ${m.name}?`, `${m.name} perderá o acesso a este canal e só volta com um convite novo.`, 'Remover membro'))) return;
          await api(ch(`/members/${m.id}`), { method: 'DELETE' }).then(() => toast('Membro removido.'), (err) => toast(err.message, true));
          loadMembers();
        });
        li.append(remove);
      }
      return li;
    }),
  );
}

async function loadDiscordChannels() {
  const notify = $('#discord-notify');
  const clips = $('#discord-clips');
  try {
    const data = await api(ch('/discord'));
    const options = (selected, none) => [
      new Option(none, ''),
      ...data.textChannels.map((c) => new Option(`#${c.name}`, c.id, false, c.id === selected)),
    ];
    notify.replaceChildren(...options(data.notifyChannelId, 'Desativado'));
    clips.replaceChildren(...options(data.clipsChannelId, 'Mesmo canal dos avisos'));
    notify.value = data.notifyChannelId;
    clips.value = data.clipsChannelId;
  } catch (err) {
    toast(err.message, true);
  }
}

for (const select of [$('#discord-notify'), $('#discord-clips')]) {
  select.addEventListener('change', async () => {
    try {
      await api(ch('/discord'), {
        method: 'PUT',
        body: { notifyChannelId: $('#discord-notify').value, clipsChannelId: $('#discord-clips').value },
      });
      toast('Avisos do Discord salvos.');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------------- app desktop (Tauri) ----------------
// Dentro do app, a captura é nativa: GPU, codec e bitrate escolhidos pelo usuário,
// áudio do sistema sem o som do próprio app.

const desktop = window.__TAURI__ || null;

function selfPreviewEnabled() {
  return store.get('self-preview', '1') === '1';
}

// Liga/desliga a prévia da própria transmissão (só vídeo, nunca o áudio)
function applySelfPreview() {
  const mine = state.me && state.room?.remoteParticipants.get(state.me.id + DESKTOP_SUFFIX);
  if (!mine) return;
  for (const pub of mine.trackPublications.values()) {
    if (pub.kind === Track.Kind.Video) pub.setSubscribed(selfPreviewEnabled());
  }
}

const DESKTOP_QUALITY = {
  '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 14_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 5_000_000 },
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
};

async function setupDesktop() {
  if (!desktop) return;
  try {
    const version = await desktop.core.invoke('app_version');
    const base = `site ${SITE_VERSION} • app ${version}`;
    $('#build').textContent = base;
    // Atualização automática: o app avisa aqui enquanto baixa/instala a versão nova
    const UPDATE_TEXT = {
      checking: () => 'procurando atualização…',
      downloading: (v) => `baixando a versão ${v}…`,
      waiting: (v) => `versão ${v} pronta: instala quando você parar de transmitir`,
      installing: (v) => `instalando a versão ${v}, o app vai reabrir…`,
    };
    const btn = $('#btn-update');
    btn.hidden = false;
    let manualCheck = false; // só avisa "já está atualizado" quando foi pelo botão
    const showUpdate = (s) => {
      const text = s && UPDATE_TEXT[s.state]?.(s.version);
      $('#build').textContent = text ? `${base} • ${text}` : base;
      btn.disabled = ['checking', 'downloading', 'installing'].includes(s?.state);
      if (manualCheck && s?.state === 'none') {
        manualCheck = false;
        toast(`Você já está na versão mais nova (${version}).`);
      }
      if (manualCheck && s?.state === 'error') {
        manualCheck = false;
        toast(`Não deu para atualizar: ${s.message || 'erro desconhecido'}`, true);
      }
    };
    btn.addEventListener('click', async () => {
      try {
        manualCheck = true;
        const started = await desktop.core.invoke('check_update');
        if (!started) toast('Já estou procurando/baixando a atualização, só um instante.');
      } catch {
        manualCheck = false; // app antigo, sem o comando: ele procura sozinho ao abrir
        toast('Feche e abra o app: ele procura a versão nova sempre que abre.');
      }
    });
    desktop.core.invoke('update_status').then(showUpdate).catch(() => {});
    desktop.event.listen('update-state', (e) => showUpdate(e.payload)).catch(() => {});
  } catch {
    $('#build').textContent = `site ${SITE_VERSION} • app antigo (baixe a versão nova)`;
  }
  document.body.classList.add('is-desktop');
  $('#desktop-opts').hidden = false;
  $('#browser-audio-hint').hidden = true;
  $('#desktop-promo').hidden = true;
  $('#broadcast-source').replaceChildren(ico('windows'), 'App Windows · captura pela GPU');
  $('#opt-quality').innerHTML = `
    <option value="1440p60">1440p · 60 fps (rede forte)</option>
    <option value="1080p60">1080p · 60 fps (recomendado)</option>
    <option value="1080p30">1080p · 30 fps</option>
    <option value="720p60">720p · 60 fps</option>
    <option value="720p30">720p · 30 fps (internet fraca)</option>`;
  $('#opt-quality').value = store.get('desktop-quality', '1080p60');
  $('#opt-quality').addEventListener('change', (e) => store.set('desktop-quality', e.target.value));
  // Placa de vídeo (NVENC/AMF/QuickSync via Media Foundation), se o app suportar e houver hardware.
  // Sem ela, VP8: medido no app, ~55 fps em 1080p (o H.264 por software empaca em ~30).
  let gpu = null;
  try {
    gpu = await desktop.core.invoke('gpu_encoder');
  } catch {
    gpu = null; // versão antiga do app, sem o comando
  }
  if (gpu) {
    const option = document.createElement('option');
    option.value = 'gpu';
    option.textContent = `Placa de vídeo: ${gpu.replace(/ ?Encoder ?MFT/i, '')} (recomendado)`;
    $('#opt-codec').prepend(option);
  }
  $('#opt-codec').value = store.get('desktop-codec-v3', gpu ? 'gpu' : 'vp8');
  if (!$('#opt-codec').value) $('#opt-codec').value = 'vp8';
  $('#opt-codec').addEventListener('change', (e) => store.set('desktop-codec-v3', e.target.value));
  $('#opt-preview').checked = selfPreviewEnabled();
  $('#opt-preview').addEventListener('change', (e) => {
    store.set('self-preview', e.target.checked ? '1' : '0');
    applySelfPreview();
  });

  await loadSources();
  $('#btn-refresh-sources').addEventListener('click', () => loadSources());
  // Jogo aberto depois: a lista se atualiza sozinha (menos enquanto o seletor está aberto)
  setInterval(() => {
    if (!state.local && document.activeElement !== $('#opt-monitor')) loadSources({ quiet: true });
  }, 10_000);
  $('#opt-monitor').addEventListener('change', () => {
    const option = $('#opt-monitor').selectedOptions[0];
    store.set('desktop-source', option?.dataset.key || 'm:0');
    updateSourceOptions();
  });
  $('#opt-stretch').checked = store.get('desktop-stretch', '0') === '1';
  $('#opt-stretch').addEventListener('change', (e) => store.set('desktop-stretch', e.target.checked ? '1' : '0'));
  $('#opt-audio-mode').value = store.get('desktop-audio-mode', 'system');
  $('#opt-audio-mode').addEventListener('change', (e) => store.set('desktop-audio-mode', e.target.value));

  await desktop.event.listen('stream-state', ({ payload }) => {
    if (payload.state === 'live') {
      toast(`Você está ao vivo! 🔴 (${payload.encoder || 'codificador padrão'})`);
    } else if (payload.state === 'stopped' || payload.state === 'error') {
      if (payload.state === 'error') toast(`Transmissão encerrada: ${payload.message}`, true);
      if (state.local?.native) {
        cleanupLocal();
        api(ch('/desktop/stop'), { method: 'POST' }).catch(() => {});
        renderPresence();
      }
    }
  });

  // Atalhos globais (padrão Ctrl+F9/F10/F11): clipa sem abrir o diálogo, porque você está no jogo
  await desktop.event.listen('clip-hotkey', ({ payload }) => hotkeyClip(Number(payload)));
  await applyClipHotkeys();
}

// ---------------- botões de clipe configuráveis ----------------
// Cada botão tem uma duração (durações rápidas do Clipar) e, no app desktop, um atalho
// global. Fica salvo neste aparelho.

const DEFAULT_CLIP_SLOTS = [
  { seconds: 30, key: 'Ctrl+F9' },
  { seconds: 60, key: 'Ctrl+F10' },
  { seconds: 180, key: 'Ctrl+F11' },
];
const CLIP_DURATIONS = [10, 15, 20, 30, 45, 60, 90, 120, 150, 180];
let hotkeyErrors = {}; // atalho -> motivo (ex.: outro programa usa)
let hotkeysSupported = true; // app antigo não tem o comando

function clipSlots() {
  try {
    const saved = JSON.parse(store.get('clip-slots', 'null'));
    if (Array.isArray(saved) && saved.length === 3) {
      return saved.map((s, i) => ({
        seconds: CLIP_DURATIONS.includes(Number(s.seconds)) ? Number(s.seconds) : DEFAULT_CLIP_SLOTS[i].seconds,
        key: typeof s.key === 'string' ? s.key : '',
      }));
    }
  } catch { /* volta pro padrão */ }
  return DEFAULT_CLIP_SLOTS.map((s) => ({ ...s }));
}

function saveClipSlots(slots) {
  store.set('clip-slots', JSON.stringify(slots));
  renderClipSettings();
  applyClipHotkeys();
}

/** "Ctrl+KeyK" -> "Ctrl+K" (como aparece na tela) */
const keyLabel = (key) => key.replace(/Key([A-Z])$/, '$1').replace(/Digit(\d)$/, '$1');

/** Menu do Clipar: as três durações rápidas e a lista completa (10 s a 3 min). */
function fillClipMenu(menu, tile) {
  const head = document.createElement('div');
  head.className = 'overline';
  head.textContent = tile ? `Clipar ${tile.name}` : 'Clipar';
  const quick = clipSlots().map(({ seconds }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.seconds = String(seconds);
    b.textContent = `Últimos ${lengthLabel(seconds)}`;
    return b;
  });
  const other = document.createElement('select');
  other.setAttribute('aria-label', 'Outra duração');
  other.append(new Option('Outra duração…', ''), ...CLIP_DURATIONS.map((s) => new Option(`Últimos ${lengthLabel(s)}`, String(s))));
  menu.replaceChildren(head, ...quick, other);
}

async function applyClipHotkeys() {
  if (!desktop) return;
  const slots = clipSlots().filter((s) => s.key);
  try {
    const results = await desktop.core.invoke('set_clip_hotkeys', {
      hotkeys: slots.map((s) => ({ shortcut: s.key, seconds: s.seconds })),
    });
    hotkeyErrors = Object.fromEntries(results.filter((r) => !r.ok).map((r) => [r.shortcut, r.error]));
  } catch (err) {
    console.warn('[atalhos]', err); // app antigo: ficam os atalhos fixos Ctrl+F9/F10/F11
    hotkeysSupported = false;
  }
  renderClipSettings();
}

/** Converte uma tecla apertada no formato do app ("Ctrl+Shift+KeyK" ou só "KeyK"). Qualquer tecla vale. */
function shortcutFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key) || !e.code) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  return [...mods, e.code].join('+');
}

let capturing = null; // índice do botão esperando a tecla

/** Seções Clipes (durações) e App Windows (atalhos) das configurações. */
function renderClipSettings() {
  const slots = clipSlots();
  $('#clip-slots').replaceChildren(...slots.map((slot, i) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `Opção ${i + 1}`;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Duração da opção ${i + 1}`);
    for (const s of CLIP_DURATIONS) select.append(new Option(lengthLabel(s), String(s)));
    select.value = String(slot.seconds);
    select.addEventListener('change', () => {
      slots[i].seconds = Number(select.value);
      saveClipSlots(slots);
      toast('Durações salvas.');
    });
    li.append(label, select);
    return li;
  }));

  const withKeys = desktop && hotkeysSupported;
  $('#hotkeys-hint').textContent = !desktop
    ? 'Os atalhos funcionam no app Faz o L para Windows, inclusive com o jogo em primeiro plano. Abra este site pelo app para configurar.'
    : hotkeysSupported
      ? 'Ativos no app, inclusive com o jogo em primeiro plano. Clique no atalho e aperte a combinação (Esc cancela, Backspace remove). Tecla sozinha, sem Ctrl/Alt, deixa de digitar nos outros programas enquanto o app estiver aberto.'
      : 'Atualize o app para trocar os atalhos (por enquanto: Ctrl+F9, Ctrl+F10 e Ctrl+F11).';
  $('#hotkey-slots').replaceChildren(...slots.map((slot, i) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `Clipar ${lengthLabel(slot.seconds)}`;
    li.append(label);
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'clip-key';
    const error = slot.key && hotkeyErrors[slot.key];
    key.classList.toggle('error', !!error);
    key.classList.toggle('waiting', capturing === i);
    key.disabled = !withKeys;
    key.textContent = capturing === i ? 'Aperte as teclas…' : slot.key ? keyLabel(slot.key) : 'Sem atalho';
    key.title = error ? `Não funcionou: ${error}` : 'Clique e aperte o atalho';
    key.addEventListener('click', () => startCapture(i));
    const right = document.createElement('div');
    right.className = 'button-row';
    if (error) {
      const warn = document.createElement('span');
      warn.className = 'clip-key-error';
      warn.textContent = error;
      right.append(warn);
    }
    right.append(key);
    li.append(right);
    return li;
  }));
}

async function startCapture(index) {
  capturing = index;
  renderClipSettings();
  // Enquanto escolhe, solta os atalhos (senão apertar Ctrl+F9 já clipa)
  await desktop.core.invoke('set_clip_hotkeys', { hotkeys: [] }).catch(() => {});
}

document.addEventListener('keydown', (e) => {
  if (capturing === null) return;
  e.preventDefault();
  e.stopPropagation();
  const slots = clipSlots();
  if (e.key === 'Escape') {
    capturing = null;
    return applyClipHotkeys();
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    slots[capturing].key = '';
  } else {
    const shortcut = shortcutFromEvent(e);
    if (!shortcut) return; // só modificador ainda
    // Mesmo atalho em outro botão: tira de lá
    for (const s of slots) if (s.key === shortcut) s.key = '';
    slots[capturing].key = shortcut;
  }
  capturing = null;
  saveClipSlots(slots);
}, true);

$('#dlg-settings').addEventListener('close', () => {
  if (capturing !== null) {
    capturing = null;
    applyClipHotkeys();
  }
});
// Esc durante a captura do atalho não fecha o painel
$('#dlg-settings').addEventListener('cancel', (e) => {
  if (capturing !== null) e.preventDefault();
});

$('#clip-settings-reset').addEventListener('click', () => {
  capturing = null;
  store.set('clip-slots', 'null');
  renderClipSettings();
  applyClipHotkeys();
  toast('Durações padrão restauradas.');
});
renderClipSettings();

let hotkeyBusy = false;

/** Qual live clipar: a sua (se estiver transmitindo), senão a em destaque, senão a única aberta. */
function clipTarget() {
  if (!state.room) return null;
  if (state.local || myAppStream()) return state.me.id;
  // O evento (YouTube) não vira clipe: o gravador só pega as lives da sala
  const lives = [...state.tiles.values()].filter((t) => !t.isEvent);
  let id = null;
  const main = mainTileId();
  if (state.focus && main && !state.tiles.get(main).isEvent && lives.length > 1) id = main;
  else if (lives.length === 1) id = lives[0].id;
  return id === '__local__' ? state.me.id : id;
}

async function hotkeyClip(seconds) {
  if (!state.room || hotkeyBusy) return;
  const streamer = clipTarget();
  if (!streamer) return toast('Atalho de clipe: use Destacar numa live para saber qual clipar.', true);
  hotkeyBusy = true;
  toast(`Gerando clipe dos últimos ${lengthLabel(seconds)}…`);
  try {
    const clip = await api(ch('/clips'), { method: 'POST', body: { streamer, seconds } });
    await api(`/api/clips/${clip.id}`, { method: 'PATCH', body: { publish: true } });
    toast(`Clipe de ${lengthLabel(seconds)} publicado! Dá pra pôr título depois na lista de clipes.`);
    loadClips();
  } catch (err) {
    toast(err.message, true);
  } finally {
    hotkeyBusy = false;
  }
}

// Monitores + janelas (jogos primeiro). A escolha é lembrada pelo nome do processo,
// porque o identificador da janela muda toda vez que o jogo abre.
let windowsSupported = true;
async function loadSources({ quiet = false } = {}) {
  const select = $('#opt-monitor');
  if (select.dataset.loading) return;
  select.dataset.loading = '1';
  const current = select.selectedOptions[0]?.dataset.key || store.get('desktop-source', 'm:0');
  try {
    const monitors = await desktop.core.invoke('list_monitors').catch((err) => {
      if (!quiet) toast(`Não consegui listar os monitores: ${err}`, true);
      return [];
    });
    let windows = [];
    try {
      windows = await desktop.core.invoke('list_windows');
    } catch {
      windowsSupported = false; // app antigo: só monitor
    }

    const group = (label, items) => {
      const g = document.createElement('optgroup');
      g.label = label;
      g.append(...items);
      return g;
    };
    const option = (text, value, key) => {
      const o = new Option(text, value);
      o.dataset.key = key;
      return o;
    };
    const monitorOptions = monitors.map((m) =>
      option(`🖥 ${m.name} (${m.width}x${m.height})${m.primary ? ' • principal' : ''}`, `m:${m.index}`, `m:${m.index}`));
    const games = windows.filter((w) => w.game);
    const others = windows.filter((w) => !w.game);
    const windowOption = (w) => {
      const label = w.game ? `🎮 ${w.game}` : `🪟 ${w.title.slice(0, 60)}`;
      return option(label, `w:${w.id}`, `p:${(w.process || w.title).toLowerCase()}`);
    };
    const groups = [group('Monitores', monitorOptions)];
    if (games.length) groups.push(group('Jogos abertos', games.map(windowOption)));
    if (others.length) groups.push(group('Janelas', others.map(windowOption)));
    select.replaceChildren(...groups);

    const match = [...select.options].find((o) => o.dataset.key === current);
    if (match) select.value = match.value;
  } finally {
    delete select.dataset.loading;
    updateSourceOptions();
  }
}

function updateSourceOptions() {
  const isWindow = $('#opt-monitor').value.startsWith('w:');
  $('#btn-refresh-sources').hidden = !windowsSupported;
  $('#opt-stretch').closest('label').hidden = !windowsSupported;
  $('#opt-audio-mode').closest('label').hidden = !windowsSupported || !isWindow;
}

function selectedSource() {
  const value = $('#opt-monitor').value || 'm:0';
  if (value.startsWith('w:')) return { monitor: 0, window: value.slice(2) };
  return { monitor: Number(value.replace(/^m:/, '')) || 0, window: null };
}

async function startNativeStream() {
  const q = DESKTOP_QUALITY[$('#opt-quality').value] || DESKTOP_QUALITY['1080p60'];
  const source = selectedSource();
  state.busy = true;
  renderPresence();
  try {
    const { token, url } = await api(ch('/desktop/token'), { method: 'POST' });
    await desktop.core.invoke('start_stream', {
      args: {
        url,
        token,
        monitor: source.monitor,
        window: source.window,
        stretch: $('#opt-stretch').checked,
        audio_mode: source.window ? $('#opt-audio-mode').value : 'system',
        width: q.width,
        height: q.height,
        fps: q.fps,
        bitrate: q.bitrate,
        codec: $('#opt-codec').value,
        audio: $('#opt-audio').checked,
      },
    });
    state.local = { native: true };
    $('#dlg-broadcast').close();
  } catch (err) {
    await api(ch('/desktop/stop'), { method: 'POST' }).catch(() => {});
    toast(typeof err === 'string' ? err : err.message || 'Não foi possível transmitir.', true);
  } finally {
    state.busy = false;
    renderPresence();
  }
}

$('#build').textContent = `site ${SITE_VERSION}${desktop ? ' • app desktop' : ''}`;
route().catch((err) => toast(err.message, true));
setupDesktop();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.mini) setMiniMode(null);
});

// ---------------- evento: YouTube assistido junto ----------------
// Ninguém transmite: cada um toca o vídeo direto do YouTube e o servidor diz em que
// segundo todo mundo deve estar (src/events.js). Quem começou o evento (ou o dono do
// canal) controla tocar, pausar, pular e encerrar. Se alguém escapar mais de ~1,5 s
// do ponto certo, o player volta sozinho pro lugar.

const EVENT_TILE = '__event__';
const ev = {
  data: null, // { videoId, title, by, playing, position, updatedAt }
  offset: 0, // relógio do servidor - relógio daqui
  player: null,
  videoId: null,
  ready: false,
  muted: true, // como as lives: começa sem som
  volume: Number(store.get('event-volume', '80')),
  timer: null,
  seeking: false,
};
let ytApiPromise = null;

function loadYouTubeApi(target = window) {
  if (target !== window) {
    if (target.YT?.Player) return Promise.resolve(target.YT);
    return new Promise((resolve, reject) => {
      target.onYouTubeIframeAPIReady = () => resolve(target.YT);
      const script = target.document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => reject(new Error('Não consegui carregar o player na janela flutuante.'));
      target.document.head.append(script);
    });
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve(window.YT);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        ytApiPromise = null;
        reject(new Error('Não consegui carregar o player do YouTube.'));
      };
      document.head.append(script);
    });
  }
  return ytApiPromise;
}

// Estados do player (os números do YouTube); o player da Twitch abaixo usa os mesmos
const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
let twitchApiPromise = null;

function loadTwitchApi(target = window) {
  if (target !== window) {
    if (target.Twitch?.Player) return Promise.resolve(target.Twitch);
    return new Promise((resolve, reject) => {
      const script = target.document.createElement('script');
      script.src = 'https://player.twitch.tv/js/embed/v1.js';
      script.onload = () => resolve(target.Twitch);
      script.onerror = () => reject(new Error('Não consegui carregar o player na janela flutuante.'));
      target.document.head.append(script);
    });
  }
  if (window.Twitch?.Player) return Promise.resolve(window.Twitch);
  if (!twitchApiPromise) {
    twitchApiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://player.twitch.tv/js/embed/v1.js';
      script.onload = () => resolve(window.Twitch);
      script.onerror = () => {
        twitchApiPromise = null;
        reject(new Error('Não consegui carregar o player da Twitch.'));
      };
      document.head.append(script);
    });
  }
  return twitchApiPromise;
}

const twitchTime = (s) => {
  const t = Math.floor(s);
  return `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
};

/**
 * Player da Twitch com a mesma cara do player do YouTube (getCurrentTime, seekTo, playVideo…),
 * pra sincronia funcionar igual. Live da Twitch não tem como pular: todo mundo fica na ponta.
 */
function createTwitchPlayer(holder, media, startSeconds) {
  holder.id = `ev-twitch-${Date.now()}`;
  const opts = { width: '100%', height: '100%', parent: [location.hostname], autoplay: true, muted: true, controls: false };
  if (media.kind === 'channel') opts.channel = media.id;
  else {
    opts.video = media.id;
    if (startSeconds > 1) opts.time = twitchTime(startSeconds);
  }
  const T = holder.ownerDocument.defaultView.Twitch.Player;
  const tp = new T(holder.id, opts);
  let st = PS.UNSTARTED;
  const live = media.kind === 'channel';
  const adapter = {
    twitch: true,
    getPlayerState: () => st,
    getCurrentTime: () => tp.getCurrentTime() || 0,
    getDuration: () => (live ? 0 : tp.getDuration() || 0),
    getVideoData: () => ({ isLive: live }),
    seekTo: (t) => { if (!live) tp.seek(t); },
    playVideo: () => tp.play(),
    pauseVideo: () => tp.pause(),
    setVolume: (v) => tp.setVolume(v / 100),
    mute: () => tp.setMuted(true),
    unMute: () => tp.setMuted(false),
    destroy: () => holder.replaceChildren(),
  };
  const ready = new Promise((resolve) => tp.addEventListener(T.READY, resolve));
  tp.addEventListener(T.PLAYING, () => { st = PS.PLAYING; renderEventTime(); });
  tp.addEventListener(T.PAUSE, () => { st = PS.PAUSED; renderEventTime(); });
  tp.addEventListener(T.ENDED, () => { st = PS.ENDED; });
  tp.addEventListener(T.OFFLINE, () => toast('Evento: esse canal da Twitch está offline agora.', true));
  return { adapter, ready };
}

/**
 * Live da Kick: o player embutido da Kick não aceita comandos de fora (nem tocar, nem volume,
 * nem saber em que ponto está). Todo mundo abre a live na ponta e usa os controles do próprio
 * player da Kick (o som fica nele).
 */
function createKickPlayer(holder, channel) {
  const frame = document.createElement('iframe');
  frame.src = `https://player.kick.com/${encodeURIComponent(channel)}?autoplay=true&muted=true`;
  frame.allow = 'autoplay; fullscreen; picture-in-picture';
  frame.allowFullscreen = true;
  holder.replaceChildren(frame);
  const ready = new Promise((resolve) => {
    frame.addEventListener('load', resolve, { once: true });
    setTimeout(resolve, 8000);
  });
  const noop = () => {};
  const adapter = {
    kick: true,
    getPlayerState: () => PS.PLAYING,
    getCurrentTime: () => 0,
    getDuration: () => 0,
    getVideoData: () => ({ isLive: true }),
    seekTo: noop, playVideo: noop, pauseVideo: noop, setVolume: noop, mute: noop, unMute: noop,
    destroy: () => holder.replaceChildren(),
  };
  return { adapter, ready };
}

const mediaKey = (d) => {
  if (d.source === 'twitch') return `twitch:${d.twitch.kind}:${d.twitch.id}`;
  if (d.source === 'kick') return `kick:${d.kick.id}`;
  return `yt:${d.videoId}`;
};

const serverNow = () => Date.now() + ev.offset;
const eventTarget = (d) => d.position + (d.playing ? (serverNow() - d.updatedAt) / 1000 : 0);
const canControlEvent = () => !!ev.data && (ev.data.by.id === state.me?.id || state.channel?.role === 'owner');
const fmtTime = (total) => {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

async function loadEvent() {
  if (!state.channel) return;
  try {
    const sent = Date.now();
    const res = await api(ch('/event'));
    ev.offset = res.now - Math.round((sent + Date.now()) / 2);
    applyEvent(res.event);
  } catch (err) {
    console.warn('[evento]', err);
  }
}

function onRoomMetadata(metadata) {
  try {
    const parsed = JSON.parse(metadata || '{}');
    if ('event' in parsed) applyEvent(parsed.event);
  } catch { /* metadados de outra coisa */ }
}

function applyEvent(data) {
  const before = ev.data;
  ev.data = data || null;
  if (!ev.data) {
    if (before && state.tiles.has(EVENT_TILE)) toast('O evento acabou.');
    removeTile(EVENT_TILE);
    renderRoomActions();
    return;
  }
  if (!before) toast(`Evento: ${ev.data.title}`);
  const tile = ensureEventTile();
  renderEventTile(tile);
  ensureEventPlayer().then(() => syncEventPlayer(true)).catch((err) => toast(err.message, true));
}

function ensureEventTile() {
  let tile = state.tiles.get(EVENT_TILE);
  if (tile) return tile;
  const el = document.createElement('article');
  el.className = 'player tile tile-event has-video';
  el.setAttribute('aria-label', 'Evento');
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/img/icones.svg#i-${name}"></use></svg>`;
  el.innerHTML = `
    <div class="screen">
      <div class="event-player"><div></div></div>
      <div class="event-shield"></div>
      <div class="screen-badges">
        <span class="on-air event"><i class="dot"></i> EVENTO</span>
        <span class="ev-sync" hidden></span>
      </div>
    </div>
    <div class="player-bar">
      <div class="identity">
        <span class="avatar tile-avatar" aria-hidden="true"></span>
        <div><strong class="tile-name"></strong><small class="tile-sub"></small></div>
      </div>
      <div class="player-controls">
        <button type="button" class="icon-btn ghost ctl-mute" title="Ativar som do evento" aria-label="Ativar som do evento">${icon('mute')}</button>
        <input class="volume ctl-volume" type="range" min="0" max="100" step="1" aria-label="Volume do evento" />
        <button type="button" class="icon-btn ghost ev-play" title="Tocar pra todo mundo" aria-label="Tocar pra todo mundo">${icon('play')}</button>
        <input class="volume ev-seek" type="range" min="0" max="0" step="1" value="0" aria-label="Pular pra todo mundo" />
        <span class="ev-time"></span>
        <button type="button" class="button danger ev-stop" title="Encerrar o evento pra todo mundo">${icon('stop')}<span>Encerrar</span></button>
        <button type="button" class="icon-btn ghost ctl-focus" title="Destacar" aria-label="Destacar">${icon('focus')}</button>
        <button type="button" class="icon-btn ghost ctl-theater" title="Modo Teatro" aria-label="Modo Teatro" aria-pressed="false">${icon('theater')}</button>
        <button type="button" class="icon-btn ghost ctl-pip" title="Janela flutuante do evento" aria-label="Janela flutuante do evento"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><rect x="12" y="12" width="7" height="5.5" rx="1.2"/></svg></button>
        <button type="button" class="icon-btn ghost ctl-full" title="Tela cheia" aria-label="Tela cheia">${icon('expand')}</button>
      </div>
    </div>`;
  tile = { id: EVENT_TILE, el, isEvent: true, name: 'Evento', video: null, publication: null };

  const volume = el.querySelector('.ctl-volume');
  volume.value = String(ev.volume);
  volume.addEventListener('input', () => {
    ev.volume = Number(volume.value);
    ev.muted = ev.volume === 0;
    store.set('event-volume', String(ev.volume));
    applyEventVolume();
  });
  el.querySelector('.ctl-mute').addEventListener('click', () => {
    ev.muted = !ev.muted;
    if (!ev.muted && ev.volume === 0) {
      ev.volume = 80;
      volume.value = '80';
    }
    applyEventVolume();
  });
  el.querySelector('.ev-play').addEventListener('click', () => controlEvent(ev.data?.playing ? 'pause' : 'play'));
  const seek = el.querySelector('.ev-seek');
  seek.addEventListener('input', () => {
    ev.seeking = true;
    el.querySelector('.ev-time').textContent = `${fmtTime(Number(seek.value))} / ${fmtTime(Number(seek.max))}`;
  });
  seek.addEventListener('change', () => {
    ev.seeking = false;
    controlEvent('seek', Number(seek.value));
  });
  el.querySelector('.ev-stop').addEventListener('click', stopEvent);
  wireViewControls(tile);
  el.querySelector('.ctl-pip').addEventListener('click', () => togglePip(tile));
  el.querySelector('.screen').addEventListener('dblclick', () => {
    if (state.mini === tile.id) setMiniMode(null);
    else toggleFullscreen(el);
  });
  el.addEventListener('mousedown', e => {
    if (state.mini !== tile.id || e.button !== 0 || e.target.closest('button, input')) return;
    desktop.window.getCurrentWindow().startDragging().catch(() => {});
  });

  state.tiles.set(EVENT_TILE, tile);
  $('#stage').prepend(el);
  layout();
  return tile;
}

function renderEventTile(tile) {
  const d = ev.data;
  const control = canControlEvent();
  const source = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' }[d.source || 'youtube'] || 'Vídeo';
  tile.name = d.title;
  tile.el.querySelector('.tile-name').textContent = d.title;
  tile.el.querySelector('.tile-sub').textContent = `Evento de ${d.by.name} · ${source}`;
  tile.el.setAttribute('aria-label', `Evento: ${d.title}`);
  fillMark(tile.el.querySelector('.tile-avatar'), d.by.name, d.by.avatar);
  const kick = d.source === 'kick';
  const play = tile.el.querySelector('.ev-play');
  play.hidden = !control || kick;
  // O kit não tem pausa: mesmas regras de traço (24 × 24, 1,8 px)
  play.innerHTML = d.playing
    ? '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round"><path d="M9 6v12M15 6v12"/></svg>'
    : '<svg class="icon" aria-hidden="true"><use href="/img/icones.svg#i-play"></use></svg>';
  play.title = d.playing ? 'Pausar pra todo mundo' : 'Tocar pra todo mundo';
  play.setAttribute('aria-label', play.title);
  tile.el.querySelector('.ev-seek').hidden = !control || kick || isEventLive();
  tile.el.querySelector('.ev-stop').hidden = !control;
  // Kick: sem comandos de fora; o som e a tela cheia ficam nos controles do player da Kick
  tile.el.classList.toggle('kick', kick);
  tile.el.classList.toggle('paused', !d.playing && !kick);
  renderRoomActions();
}

function isEventLive() {
  const p = ev.player;
  if (!p || !ev.ready) return false;
  return !!p.getVideoData?.()?.isLive;
}

async function ensureEventPlayer() {
  const d = ev.data;
  if (!d || !state.tiles.has(EVENT_TILE)) return;
  const key = mediaKey(d);
  if (ev.videoId === key && (ev.player || ev.creating)) return;
  // YouTube → outro vídeo do YouTube: troca sem recriar o player
  if (ev.player && ev.ready && !ev.player.twitch && d.source !== 'twitch') {
    ev.videoId = key;
    ev.player.loadVideoById({ videoId: d.videoId, startSeconds: eventTarget(d) });
    return;
  }
  if (ev.player) destroyEventPlayer();
  ev.videoId = key;
  ev.ready = false;
  ev.creating = true;
  try {
    if (d.source === 'twitch') await createTwitch(d, key);
    else if (d.source === 'kick') await createKick(d, key);
    else await createYouTube(d, key);
  } finally {
    ev.creating = false;
  }
  if (ev.videoId !== key) return;
  clearInterval(ev.timer);
  ev.timer = setInterval(() => {
    syncEventPlayer(false);
    renderEventTime();
    if (++ev.ticks % 2 === 0) reportEventSync();
  }, 1000);
}

/** Caixa vazia pro player novo (o anterior pode ter deixado o iframe dele). */
function freshEventHolder() {
  const box = state.tiles.get(EVENT_TILE)?.el.querySelector('.event-player');
  if (!box) return null;
  box.innerHTML = '<div></div>';
  return box.firstElementChild;
}

async function createTwitch(d, key) {
  await loadTwitchApi(state.tiles.get(EVENT_TILE)?.el.ownerDocument.defaultView);
  const holder = ev.videoId === key && freshEventHolder();
  if (!holder) return;
  const { adapter, ready } = createTwitchPlayer(holder, d.twitch, eventTarget(d));
  ev.player = adapter;
  await ready;
  if (ev.player !== adapter) return;
  ev.ready = true;
  applyEventVolume();
}

async function createKick(d, key) {
  const holder = freshEventHolder();
  if (!holder) return;
  const { adapter, ready } = createKickPlayer(holder, d.kick.id);
  ev.player = adapter;
  await ready;
  if (ev.player === adapter && ev.videoId === key) ev.ready = true;
}

async function createYouTube(d, key) {
  const YT = await loadYouTubeApi(state.tiles.get(EVENT_TILE)?.el.ownerDocument.defaultView);
  const holder = ev.videoId === key && freshEventHolder();
  if (!holder) return;
  await new Promise((resolve) => {
    ev.player = new YT.Player(holder, {
      width: '100%',
      height: '100%',
      videoId: d.videoId,
      playerVars: {
        autoplay: 1, mute: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3,
        start: Math.floor(eventTarget(d)),
      },
      events: {
        onReady: () => {
          if (ev.videoId === key) {
            ev.ready = true;
            applyEventVolume();
          }
          resolve();
        },
        onStateChange: () => renderEventTime(),
        onError: (e) => {
          const msgs = {
            2: 'link inválido',
            5: 'o player não conseguiu tocar',
            100: 'vídeo não encontrado ou privado',
            101: 'o dono do vídeo não deixa tocar fora do YouTube',
            150: 'o dono do vídeo não deixa tocar fora do YouTube',
          };
          toast(`Evento: ${msgs[e.data] || `erro ${e.data} do YouTube`}.`, true);
          resolve();
        },
      },
    });
  });
}

function destroyEventPlayer() {
  clearInterval(ev.timer);
  ev.timer = null;
  try { ev.player?.destroy(); } catch { /* já foi */ }
  ev.player = null;
  ev.videoId = null;
  ev.ready = false;
}

let lastHardSync = 0;
let calibratingLive = false;
function syncEventPlayer(force) {
  const p = ev.player;
  const d = ev.data;
  if (!p || !ev.ready || !d) return;
  const S = PS;
  const st = p.getPlayerState();
  const live = isEventLive();
  if (p.kick) return;
  // Live da Twitch: não dá pra pular; todo mundo fica na ponta da live, só tocando/pausando
  if (p.twitch && live) {
    if (d.playing && st !== S.PLAYING) p.playVideo();
    else if (!d.playing && st === S.PLAYING) p.pauseVideo();
    return;
  }
  // Live: quem controla manda o "tempo da live" do player dele (igual pra todo mundo).
  // Até isso chegar, cada um fica na ponta da live, sem pular.
  if (live && !d.live) {
    // O "start" do player é em segundos desde o começo do evento: numa live isso cai no
    // começo da gravação. Vai pra ponta da live (o YouTube limita o pulo ao que existe).
    if (ev.edgeFor !== ev.videoId) {
      ev.edgeFor = ev.videoId;
      p.seekTo(1e9, true);
      return;
    }
    if (canControlEvent() && st === S.PLAYING && !calibratingLive) {
      calibratingLive = true;
      controlEvent(d.playing ? 'play' : 'pause', p.getCurrentTime(), true).finally(() => { calibratingLive = false; });
    }
    if (d.playing && (st === S.PAUSED || st === S.CUED || st === S.UNSTARTED)) p.playVideo();
    return;
  }
  const tolerance = live ? 2.5 : 1.5;
  if (d.playing) {
    if (st === S.PAUSED || st === S.CUED || st === S.UNSTARTED) p.playVideo();
    if (st !== S.ENDED) {
      const target = eventTarget(d);
      const duration = live ? Infinity : p.getDuration() || Infinity;
      const drift = p.getCurrentTime() - target;
      // Internet lenta: não fica pulando sem parar (no máximo a cada 4 s)
      if (target < duration && (force || (Math.abs(drift) > tolerance && Date.now() - lastHardSync > 4000))) {
        lastHardSync = Date.now();
        p.seekTo(target, true);
      }
    }
  } else {
    if (st === S.PLAYING || st === S.BUFFERING) p.pauseVideo();
    if (force || Math.abs(p.getCurrentTime() - d.position) > 0.5) p.seekTo(d.position, true);
  }
}

function renderEventTime() {
  const tile = state.tiles.get(EVENT_TILE);
  const p = ev.player;
  if (!tile || !p || !ev.ready || ev.seeking) return;
  const live = isEventLive();
  const time = tile.el.querySelector('.ev-time');
  const seek = tile.el.querySelector('.ev-seek');
  if (live) {
    time.textContent = 'Ao vivo';
  } else {
    const cur = p.getCurrentTime() || 0;
    const dur = p.getDuration() || 0;
    time.textContent = dur ? `${fmtTime(cur)} / ${fmtTime(dur)}` : fmtTime(cur);
    seek.max = String(Math.floor(dur));
    seek.value = String(Math.floor(cur));
  }
  seek.hidden = !canControlEvent() || live;
}

function applyEventVolume() {
  const tile = state.tiles.get(EVENT_TILE);
  if (tile) {
    const mute = tile.el.querySelector('.ctl-mute');
    const silent = ev.muted || ev.volume === 0;
    setIco(mute, silent ? 'mute' : 'volume');
    mute.title = silent ? 'Ativar som do evento' : 'Silenciar o evento';
    mute.setAttribute('aria-label', mute.title);
  }
  const p = ev.player;
  if (!p || !ev.ready) return;
  p.setVolume(ev.volume);
  if (ev.muted || ev.volume === 0) p.mute();
  else p.unMute();
}

async function controlEvent(action, position, live = false) {
  try {
    const body = { action };
    if (live) body.live = true;
    if (position !== undefined) body.position = position;
    else if (ev.player && ev.ready && (!isEventLive() || ev.data?.live)) body.position = ev.player.getCurrentTime();
    const res = await api(ch('/event'), { method: 'PATCH', body });
    applyEvent(res.event);
  } catch (err) {
    toast(err.message, true);
  }
}

async function stopEvent() {
  const title = ev.data?.title ? `“${ev.data.title}”` : 'O evento';
  if (!(await confirmAction('Encerrar evento?', `${title} será encerrado pra todo mundo na sala.`, 'Encerrar evento'))) return;
  try {
    await api(ch('/event'), { method: 'DELETE' });
    applyEvent(null);
  } catch (err) {
    toast(err.message, true);
  }
}

// Começar evento no cabeçalho; encerrar fica apenas nos controles do próprio player.
$('#btn-event').addEventListener('click', () => {
  if (ev.data) return toast(`Já tem um evento rolando (de ${ev.data.by.name}).`, true);
  $('#event-url').value = '';
  $('#event-title').value = '';
  $('#dlg-event').showModal();
  $('#event-url').focus();
});
$('#event-cancel').addEventListener('click', () => $('#dlg-event').close());
$('#form-event').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#event-start');
  btn.disabled = true;
  try {
    const sent = Date.now();
    const res = await api(ch('/event'), { method: 'POST', body: { url: $('#event-url').value, title: $('#event-title').value } });
    ev.offset = res.now - Math.round((sent + Date.now()) / 2);
    $('#dlg-event').close();
    applyEvent(res.event);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------------- evento: confirmação de que todo mundo está no mesmo ponto ----------------
// A cada 2 s cada player conta pra sala (mensagem de dados do LiveKit) quão longe está do
// ponto certo. O selo no canto do evento mostra "✓ Todos sincronizados" ou quem escapou.

const SYNC_TOPIC = 'event-sync';
const syncReports = new Map(); // dono (id da pessoa) -> { name, drift, state, at }
ev.ticks = 0;

/** Distância (s) do ponto certo: + adiantado, - atrasado. null = ainda não dá pra medir. */
function eventDrift() {
  const p = ev.player;
  const d = ev.data;
  if (!p || !ev.ready || !d) return { drift: null, state: 'loading' };
  const S = PS;
  const st = p.getPlayerState();
  if (p.kick) return { drift: 0, state: 'kick' };
  if (p.twitch && isEventLive()) {
    if ((st === S.PLAYING) !== d.playing) return { drift: null, state: 'mismatch' };
    return { drift: 0, state: d.playing ? 'live' : 'paused' };
  }
  if (isEventLive() && !d.live) return { drift: null, state: 'calibrating' };
  if (st === S.ENDED) return { drift: 0, state: 'ended' };
  if (st === S.BUFFERING) return { drift: p.getCurrentTime() - eventTarget(d), state: 'buffering' };
  const playing = st === S.PLAYING;
  if (playing !== d.playing) return { drift: p.getCurrentTime() - eventTarget(d), state: 'mismatch' };
  return { drift: p.getCurrentTime() - eventTarget(d), state: playing ? 'playing' : 'paused' };
}

function reportEventSync() {
  if (!state.room || !ev.data) return;
  const report = { ...eventDrift(), event: ev.data.id };
  const me = state.me;
  syncReports.set(me.id, { name: me.name, ...report, at: Date.now() });
  const payload = new TextEncoder().encode(JSON.stringify(report));
  state.room.localParticipant.publishData(payload, { reliable: false, topic: SYNC_TOPIC }).catch(() => {});
  renderEventSync();
}

function onEventSyncData(payload, participant, _kind, topic) {
  if (topic !== SYNC_TOPIC || !participant) return;
  try {
    const report = JSON.parse(new TextDecoder().decode(payload));
    if (!ev.data || report.event !== ev.data.id) return;
    syncReports.set(ownerOf(participant.identity), { name: participant.name || participant.identity, ...report, at: Date.now() });
    renderEventSync();
  } catch { /* mensagem de outra coisa */ }
}

function renderEventSync() {
  const tile = state.tiles.get(EVENT_TILE);
  if (!tile || !state.room) return;
  const badge = tile.el.querySelector('.ev-sync');
  const now = Date.now();
  const tolerance = isEventLive() ? 2.5 : 1.5;
  const people = participants();
  const rows = people.map((p) => {
    const owner = ownerOf(p.identity);
    const r = syncReports.get(owner);
    const name = p.name || owner;
    if (!r || r.event !== ev.data?.id || now - r.at > 8000) return { name, ok: false, text: 'carregando o vídeo…' };
    if (r.state === 'loading' || r.state === 'calibrating') return { name, ok: false, text: 'entrando no ponto certo…' };
    if (r.state === 'buffering') return { name, ok: false, text: 'carregando (internet lenta)' };
    if (r.state === 'mismatch') return { name, ok: false, text: 'tocando/pausado diferente, ajustando…' };
    if (r.state === 'live') return { name, ok: true, text: 'na ponta da live' };
    if (r.state === 'kick') return { name, ok: true, text: 'com a live da Kick aberta' };
    const off = Math.abs(r.drift);
    if (off <= tolerance) return { name, ok: true, text: `${off < 0.1 ? 'no ponto' : `${off.toFixed(1)} s`}` };
    return { name, ok: false, text: `${off.toFixed(1)} s ${r.drift > 0 ? 'adiantado' : 'atrasado'}, ajustando…` };
  });
  const synced = rows.filter((r) => r.ok).length;
  const all = synced === rows.length && rows.length > 0;
  badge.hidden = rows.length === 0;
  badge.classList.toggle('ok', all);
  badge.textContent = all
    ? `✓ ${rows.length === 1 ? 'Sincronizado' : `Todos sincronizados (${rows.length})`}`
    : `${synced} de ${rows.length} sincronizados`;
  badge.title = rows.map((r) => `${r.ok ? '✓' : '…'} ${r.name}: ${r.text}`).join('\n');
}
