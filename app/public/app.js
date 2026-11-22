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
const SITE_VERSION = '2026-11-22.13';

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

// ---------------- navegação ----------------
// Rotas: /  (meus canais) • /c/<id> (canal) • /u/<@> (perfil) • /convite/<código>

const VIEWS = ['view-login', 'view-home', 'view-invite', 'view-join', 'view-room', 'view-profile'];
function show(view) {
  for (const id of VIEWS) $(`#${id}`).hidden = id !== view;
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

function setIcon(img, fallback, url) {
  img.hidden = !url;
  if (url) img.src = url;
  if (fallback) fallback.hidden = !!url;
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
  const inviteMatch = path.match(/^\/convite\/([\w-]+)/);
  const profileMatch = path.match(/^\/u\/([^/]+)/);

  // Saiu da página do canal: sai da sala. Ver um perfil não conta: a sala (e a sua
  // transmissão) continua rodando por trás, e o "Voltar" traz de volta.
  const leavingRoom = !profileMatch && (!channelMatch || channelMatch[1] !== state.channel?.id);
  if (state.room && leavingRoom) await leave();
  if (inviteMatch) return showInvite(inviteMatch[1]);
  if (profileMatch) return showProfile(decodeURIComponent(profileMatch[1]));
  if (channelMatch) {
    if (params.get('novo')) {
      toast('Canal criado! Abra ⚙ Canal pra convidar a galera.');
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

// ---------------- meus canais ----------------

async function showHome(erro) {
  show('view-home');
  document.title = 'Faz o L';
  $('#home-name').textContent = state.me.name;
  setIcon($('#home-avatar'), null, state.me.avatar);
  $('#home-me').href = profileHref(state.me.username);
  $('#home-me').toggleAttribute('data-link', !!state.me.username);
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
  if (channels.length === 1 && !erro && first) return navigate(`/c/${channels[0].id}`, { replace: true });

  $('#no-channels').hidden = channels.length > 0;
  $('#channel-list').replaceChildren(
    ...channels.map((c) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/c/${c.id}`;
      a.dataset.link = '';
      if (c.icon) {
        const img = document.createElement('img');
        img.src = c.icon;
        img.alt = '';
        a.append(img);
      } else {
        const span = document.createElement('span');
        span.className = 'guild-fallback';
        span.textContent = c.name.slice(0, 1).toUpperCase();
        a.append(span);
      }
      const name = document.createElement('b');
      name.textContent = c.name;
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = c.role === 'owner' ? 'dono' : '';
      a.append(name, role);
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
    setIcon($('#invite-icon'), null, info.channel.icon);
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
    $('#invite-name').textContent = 'Convite inválido';
    $('#invite-error').textContent = err.message;
    $('#invite-error').hidden = false;
    $('#btn-accept').hidden = true;
  }
}

// ---------------- canal ----------------

async function showChannel(id) {
  if (state.room && state.channel?.id === id) {
    document.title = `${state.channel.name} • Faz o L`;
    return show('view-room');
  }
  try {
    state.channel = await api(`/api/c/${id}`);
  } catch (err) {
    toast(err.message, true);
    return navigate('/', { replace: true });
  }
  state.limits = state.channel.limits;
  state.members = null;
  const c = state.channel;
  document.title = `${c.name} • Faz o L`;
  $('#join-channel').textContent = c.name;
  $('#room-name').textContent = c.name;
  setIcon($('#join-icon'), $('#join-logo'), c.icon);
  setIcon($('#room-icon'), $('#room-logo'), c.icon);
  $('#btn-manage').hidden = c.role !== 'owner';
  $('#btn-profile').href = profileHref(state.me.username);
  $('#btn-profile').toggleAttribute('data-link', !!state.me.username);
  setIcon($('#hud-avatar'), null, state.me.avatar);

  show('view-join');
  $('#join-name').textContent = state.me.name;
  setIcon($('#join-avatar'), null, state.me.avatar);
  refreshJoinStatus();
}

async function refreshJoinStatus() {
  try {
    const s = await api(ch('/status'));
    const live = s.streamers.filter((x) => x.live);
    $('#join-status').textContent = live.length
      ? `🔴 Ao vivo: ${live.map((x) => x.name).join(' e ')} • ${s.viewers} assistindo`
      : `Ninguém ao vivo agora • ${s.total} na sala`;
  } catch {
    $('#join-status').textContent = '';
  }
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
$('#btn-leave').addEventListener('click', async () => {
  await leave();
  show('view-join');
  refreshJoinStatus();
});
// Gaveta da direita: um painel por vez (Transmitir / Na sala)
const PANEL_TITLES = { stream: 'Transmitir', people: 'Na sala' };
function openPanel(name, { toggle = false } = {}) {
  const drawer = $('#sidebar');
  const current = drawer.hidden ? null : drawer.dataset.panel;
  const next = toggle && name === current ? null : name;
  drawer.hidden = !next;
  $('#shell').classList.toggle('drawer-open', !!next);
  if (next) {
    drawer.dataset.panel = next;
    $('#drawer-title').textContent = PANEL_TITLES[next];
    for (const p of drawer.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== next;
  }
  for (const b of document.querySelectorAll('.rail-btn[data-panel]')) b.classList.toggle('active', b.dataset.panel === next);
  store.set('room-panel', next || '');
}
for (const b of document.querySelectorAll('.rail-btn[data-panel]')) {
  b.addEventListener('click', () => openPanel(b.dataset.panel, { toggle: true }));
}
for (const b of document.querySelectorAll('[data-open-panel]')) {
  b.addEventListener('click', () => openPanel(b.dataset.openPanel));
}
$('#drawer-close').addEventListener('click', () => openPanel(null));
$('#rail-clips').addEventListener('click', () => openClipsDialog());

async function join() {
  const btn = $('#btn-join');
  btn.disabled = true;
  btn.textContent = 'Entrando…';
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
    // Reabre o último painel (na 1ª vez, "Transmitir" em tela grande)
    openPanel(store.get('room-panel', innerWidth > 1100 ? 'stream' : '') || null);
    renderPresence();
    startClipsRefresh();
  } catch (err) {
    toast(err.message || 'Não foi possível entrar na sala.', true);
    state.room = null;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar na sala';
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
  } else {
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
    video: el.querySelector('video'),
    publication: null,
    audioTrack: null,
    volume: Number(store.get(`vol:${id}`, '1')),
    muted: true, // toda live começa sem som: quem assiste desmuta
    quality: store.get('quality', 'high'),
  };
  el.querySelector('.tile-name').textContent = isLocal ? `${name} (você)` : name;
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
  el.querySelector('.ctl-focus').addEventListener('click', () => {
    state.focus = state.focus === id ? null : id;
    layout();
  });
  el.querySelector('.ctl-full').addEventListener('click', () => toggleFullscreen(el));
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
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tile-controls')) return;
    if (state.mini === id) setMiniMode(null);
    else toggleFullscreen(el);
  });

  // ✂ Clipar: os últimos 30 s / 1 min / 3 min desta live (gerado no servidor)
  const clipMenu = el.querySelector('.clip-menu');
  el.querySelector('.ctl-clip').addEventListener('click', (e) => {
    e.stopPropagation();
    if (clipMenu.hidden) fillClipMenu(clipMenu);
    clipMenu.hidden = !clipMenu.hidden;
    el.classList.toggle('clip-open', !clipMenu.hidden);
  });
  clipMenu.addEventListener('click', (e) => {
    const seconds = Number(e.target.closest('button')?.dataset.seconds);
    if (!seconds) return;
    clipMenu.hidden = true;
    el.classList.remove('clip-open');
    // Preview do navegador: a live é publicada com a identidade do próprio usuário
    createClip(id === '__local__' ? state.me.id : id, seconds);
  });
  el.addEventListener('touchstart', () => {
    el.classList.add('touch');
    clearTimeout(tile.touchTimer);
    tile.touchTimer = setTimeout(() => el.classList.remove('touch'), 3500);
  }, { passive: true });

  state.tiles.set(id, tile);
  $('#stage').append(el);
  layout();
  return tile;
}

function removeTile(id) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  if (tile.video && pipElement() === tile.video) exitPip();
  if (state.mini === id) setMiniMode(null);
  if (tile.isEvent) destroyEventPlayer();
  tile.el.remove();
  state.tiles.delete(id);
  if (state.focus === id) state.focus = null;
  layout();
}

function layout() {
  const stage = $('#stage');
  const count = state.tiles.size;
  stage.className = `stage count-${Math.min(count, 2)}`;
  if (state.focus && count > 1) stage.classList.add('focused');
  for (const tile of state.tiles.values()) {
    tile.el.classList.toggle('is-focus', state.focus === tile.id);
    applyQuality(tile);
  }
}

function applyVolume(tile) {
  const mute = tile.el.querySelector('.ctl-mute');
  mute.textContent = tile.muted || tile.volume === 0 ? '🔇' : '🔊';
  tile.audioTrack?.setVolume(tile.muted ? 0 : tile.volume);
}

function applyQuality(tile) {
  if (!tile.publication) return;
  // No modo destaque, a live pequena vai em qualidade menor para economizar banda
  const minimized = state.focus && state.focus !== tile.id && state.tiles.size > 1;
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
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

// ---------------- picture-in-picture ----------------
// A live sai numa janela flutuante por cima de tudo (jogo, outras abas).
// O áudio continua tocando pela página, com o volume escolhido no tile.

function pipSupported(video) {
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
  if (state.mini === tile.id) return setMiniMode(null);
  if (pipElement() === tile.video) return exitPip();
  // App desktop: o WebView2 não tem picture-in-picture, o próprio app vira a janela flutuante
  if (desktop && await setMiniMode(tile.id)) return;
  try {
    if (tile.video.requestPictureInPicture) await tile.video.requestPictureInPicture();
    else tile.video.webkitSetPresentationMode('picture-in-picture');
  } catch (err) {
    console.warn('[pip]', err);
    toast(desktop
      ? 'Atualize o app Faz o L para usar a janela flutuante.'
      : 'Não deu para abrir a janela flutuante. A live já carregou?', true);
  }
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
      || [...state.tiles.values()].find((t) => !t.isLocal && !t.isEvent);
    if (tile && !tile.isEvent) togglePip(tile);
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
  $('#viewer-count').textContent = `${viewers}/${maxViewers}`;
  $('#people-count').textContent = String(all.length);

  const free = maxStreamers - streamers.length;
  const btn = $('#btn-stream');
  if (state.local) {
    btn.textContent = 'Parar transmissão';
    btn.classList.add('streaming');
    btn.disabled = false;
    $('#slots').textContent = 'Você está ao vivo 🔴';
  } else if (myAppStream()) {
    // Transmitindo pelo app desktop e assistindo aqui no navegador
    btn.textContent = 'Transmitindo pelo app';
    btn.classList.add('streaming');
    btn.disabled = true;
    $('#slots').textContent = 'Você está ao vivo pelo app 🔴 (pare por lá)';
  } else {
    btn.textContent = 'Transmitir minha tela';
    btn.classList.remove('streaming');
    btn.disabled = state.busy || free <= 0;
    $('#slots').textContent = free > 0
      ? `${free} vaga${free > 1 ? 's' : ''} para transmitir`
      : `Sem vagas: já tem ${maxStreamers} pessoas ao vivo`;
  }

  const list = $('#people');
  list.replaceChildren(
    ...all
      .sort((a, b) => Number(isStreaming(b)) - Number(isStreaming(a)))
      .map((p) => {
        const li = document.createElement('li');
        const avatar = avatarOf(p);
        const name = p.name || p.identity;
        if (avatar) {
          const img = document.createElement('img');
          img.src = avatar;
          img.alt = '';
          img.loading = 'lazy';
          li.append(img);
        } else {
          const span = document.createElement('span');
          span.className = 'avatar';
          span.textContent = name.slice(0, 1).toUpperCase();
          li.append(span);
        }
        const username = usernameOf(p);
        const label = document.createElement(username ? 'a' : 'span');
        if (username) {
          label.href = profileHref(username);
          label.dataset.link = '';
          label.className = 'person-link';
          label.title = `Perfil de ${name}`;
        }
        label.textContent = p === state.room.localParticipant ? `${name} (você)` : name;
        li.append(label);
        if (isStreaming(p)) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = 'AO VIVO';
          li.append(tag);
        }
        return li;
      }),
  );
}

// ---------------- transmitir ----------------

$('#btn-stream').addEventListener('click', () => (state.local ? stopStream() : startStream()));
$('#opt-quality').value = store.get('stream-quality', '1080p30');
$('#opt-content').value = store.get('stream-content', 'motion');
$('#opt-quality').addEventListener('change', (e) => store.set('stream-quality', e.target.value));
$('#opt-content').addEventListener('change', (e) => store.set('stream-content', e.target.value));

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
    toast('Você está ao vivo! 🔴');
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

document.addEventListener('click', () => {
  for (const menu of document.querySelectorAll('.clip-menu')) menu.hidden = true;
  for (const tile of document.querySelectorAll('.tile.clip-open')) tile.classList.remove('clip-open');
});

let clipsTimer = null;
const lengthLabel = (seconds) => {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m ? (s ? `${m} min ${s} s` : `${m} min`) : `${s} s`;
};

async function createClip(streamer, seconds) {
  toast(`✂ Gerando clipe dos últimos ${lengthLabel(seconds)}…`);
  try {
    const clip = await api(ch('/clips'), { method: 'POST', body: { streamer, seconds } });
    loadClips();
    openClipDialog(clip);
    return clip;
  } catch (err) {
    toast(err.message, true);
  }
}

// Depois de clipar: título e descrição (opcionais). Publicar/Pular manda o link pro Discord.
let editingClip = null;
function openClipDialog(clip) {
  editingClip = clip;
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
    const tagged = saved.mentions.length ? ` • ${saved.mentions.length} marcado(s)` : '';
    toast(`Clipe publicado!${tagged}`);
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

async function loadClips() {
  if (!state.me || !state.channel) return;
  try {
    const { clips } = await api(ch('/clips'));
    clipsView.clips = clips;
    renderClipsPanel(clips);
    if ($('#dlg-clips').open) renderClipsDialog();
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

function clipCard(clip, options) {
  const li = document.createElement('li');
  li.className = 'clip';

  const video = document.createElement('video');
  video.src = clip.url;
  video.preload = 'metadata';
  video.controls = true;
  video.playsInline = true;

  li.append(video, ...clipDetails(clip, options));
  return li;
}

/** Título, descrição, informações e botões (copiar, baixar, editar, salvar, excluir). */
function clipDetails(clip, { onChange, showChannel = false }) {
  const meta = document.createElement('div');
  meta.className = 'clip-meta';
  const title = document.createElement('div');
  title.className = 'clip-title';
  if (clip.title) title.append(withMentions(clip.title, clip.mentions));
  else title.append('Live de ', personLink(clip.streamer));
  meta.append(title);

  if (clip.description) {
    const desc = document.createElement('div');
    desc.className = 'clip-desc';
    desc.append(withMentions(clip.description, clip.mentions));
    meta.append(desc);
  }

  const info = document.createElement('div');
  info.className = 'muted';
  if (clip.title) info.append('live de ', personLink(clip.streamer), ' • ');
  info.append(`${lengthLabel(clip.seconds)} • por `, personLink(clip.creator));
  info.append(` • ${timeAgo(clip.createdAt)} • ${clip.saved ? 'salvo ⭐' : timeLeft(clip.expiresAt)}`);
  if (showChannel && clip.channel) info.append(` • ${clip.channel.name}`);
  meta.append(info);

  const actions = document.createElement('div');
  actions.className = 'clip-actions';
  const link = `${location.origin}${clip.page}`;

  const copy = document.createElement('button');
  copy.textContent = '🔗 Copiar link';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copiado! Cole no Discord.');
    } catch {
      prompt('Copie o link do clipe:', link);
    }
  });

  const download = document.createElement('a');
  download.textContent = '⬇ Baixar';
  download.href = clip.url;
  download.download = `faz-o-l-${clip.id}.${clip.mime.includes('mp4') ? 'mp4' : 'webm'}`;
  actions.append(copy, download);

  if (clip.mine) {
    const edit = document.createElement('button');
    edit.textContent = '✏ Editar';
    edit.title = 'Título, descrição e marcações';
    edit.addEventListener('click', () => openEditDialog(clip, onChange));
    actions.append(edit);
  }
  // Salvar: qualquer pessoa do canal. Tirar dos salvos: quem salvou, quem clipou ou o dono.
  if (clip.canSave ?? clip.mine) {
    const save = document.createElement('button');
    const savedBy = clip.savedBy ? `Salvo por ${clip.savedBy}` : 'Salvo';
    save.textContent = clip.saved ? '⭐ Salvo' : '☆ Salvar';
    save.className = clip.saved ? 'saved' : '';
    save.disabled = clip.saved && clip.canUnsave === false;
    save.title = !clip.saved ? 'Guardar pra sempre (senão expira em 24 h)'
      : save.disabled ? savedBy : `${savedBy}. Clique pra deixar expirar em 24 h`;
    save.addEventListener('click', async () => {
      try {
        await api(`/api/clips/${clip.id}`, { method: 'PATCH', body: { saved: !clip.saved } });
        onChange?.();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.append(save);
  }
  if (clip.canDelete) {
    const del = document.createElement('button');
    del.textContent = '🗑';
    del.title = 'Excluir clipe';
    del.className = 'danger';
    del.addEventListener('click', async () => {
      if (!confirm('Excluir este clipe? Não dá pra desfazer.')) return;
      try {
        await api(`/api/clips/${clip.id}`, { method: 'DELETE' });
        onChange?.();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.append(del);
  }

  return [meta, actions];
}

// ---------------- janela de clipes (player grande + lista) ----------------

const clipsView = { clips: [], selected: null, filter: 'all' };

function clipThumb(clip) {
  const thumb = document.createElement('div');
  thumb.className = 'clip-thumb';
  const video = document.createElement('video');
  video.src = `${clip.url}#t=0.5`; // primeiro quadro como miniatura
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  const len = document.createElement('span');
  len.className = 'clip-len';
  len.textContent = lengthLabel(clip.seconds);
  thumb.append(video, len);
  return thumb;
}

function clipRow(clip, onClick) {
  const li = document.createElement('li');
  li.className = 'clip-row';
  li.tabIndex = 0;
  const text = document.createElement('div');
  text.className = 'clip-row-text';
  const title = document.createElement('div');
  title.className = 'clip-title';
  title.textContent = clip.title || `Live de ${clip.streamer.name}`;
  const info = document.createElement('div');
  info.className = 'muted';
  info.textContent = `${clip.title ? `${clip.streamer.name} • ` : ''}por ${clip.creator.name} • ${timeAgo(clip.createdAt)}${clip.saved ? ' • ⭐' : ''}`;
  text.append(title, info);
  li.append(clipThumb(clip), text);
  li.addEventListener('click', onClick);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onClick();
  });
  return li;
}

/** Linha do tempo na base da sala: miniaturas dos clipes recentes (abrem a janela grande). */
function renderClipsPanel(clips) {
  $('#clips-count').textContent = clips.length ? String(clips.length) : '';
  $('#btn-clips').textContent = clips.length ? `Ver todos (${clips.length})` : 'Ver todos';
  const list = $('#clips');
  if (!clips.length) {
    const li = document.createElement('li');
    li.className = 'tl-empty';
    li.textContent = 'Nenhum clipe ainda — use os botões ao lado ou os atalhos.';
    return list.replaceChildren(li);
  }
  // Mantém as miniaturas já carregadas (a lista recarrega a cada 30 s)
  const old = new Map([...list.children].map((li) => [li.dataset.id, li]));
  list.replaceChildren(
    ...clips.slice(0, 20).map((clip) => {
      const key = `${clip.id}|${clip.title}`;
      const existing = old.get(clip.id);
      if (existing?.dataset.key === key) return existing;
      const li = document.createElement('li');
      li.className = 'tl-clip';
      li.tabIndex = 0;
      li.dataset.id = clip.id;
      li.dataset.key = key;
      li.title = clip.title || `Live de ${clip.streamer.name}`;
      const thumb = clipThumb(clip);
      const title = document.createElement('span');
      title.className = 'tl-title';
      title.textContent = li.title;
      li.append(...thumb.childNodes, title);
      li.addEventListener('click', () => openClipsDialog(clip.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openClipsDialog(clip.id);
      });
      return li;
    }),
  );
}

function filteredClips() {
  const { clips, filter } = clipsView;
  if (filter === 'mine') return clips.filter((c) => c.mine);
  if (filter === 'saved') return clips.filter((c) => c.saved);
  return clips;
}

function selectClip(id, { autoplay = true } = {}) {
  const clip = clipsView.clips.find((c) => c.id === id);
  const player = $('#clips-player');
  const info = $('#clips-player-info');
  clipsView.selected = clip?.id || null;
  for (const row of $('#clips-modal-list').children) row.classList.toggle('active', row.dataset.id === clipsView.selected);
  if (!clip) {
    player.removeAttribute('src');
    player.load();
    info.replaceChildren();
    return;
  }
  if (player.dataset.clip !== clip.id) {
    player.dataset.clip = clip.id;
    player.src = clip.url;
    if (autoplay) player.play().catch(() => {});
  }
  info.replaceChildren(...clipDetails(clip, { onChange: loadClips }));
}

function renderClipsDialog() {
  const clips = filteredClips();
  $('#clips-modal-count').textContent = `(${clips.length})`;
  for (const b of $('#clips-filter').children) b.classList.toggle('active', b.dataset.filter === clipsView.filter);
  const list = $('#clips-modal-list');
  if (!clips.length) {
    const li = document.createElement('li');
    li.className = 'empty-clips';
    li.textContent = clipsView.filter === 'all' ? 'Nenhum clipe ainda.' : 'Nenhum clipe aqui.';
    list.replaceChildren(li);
  } else {
    list.replaceChildren(
      ...clips.map((clip) => {
        const row = clipRow(clip, () => selectClip(clip.id));
        row.dataset.id = clip.id;
        return row;
      }),
    );
  }
  const keep = clips.some((c) => c.id === clipsView.selected) ? clipsView.selected : clips[0]?.id;
  selectClip(keep, { autoplay: false });
}

function openClipsDialog(id = null) {
  if (id) {
    clipsView.selected = id;
    if (!filteredClips().some((c) => c.id === id)) clipsView.filter = 'all';
  }
  renderClipsDialog();
  $('#dlg-clips').showModal();
  if (id) $('#clips-player').play().catch(() => {});
}

$('#btn-clips').addEventListener('click', () => openClipsDialog());
$('#clips-close').addEventListener('click', () => $('#dlg-clips').close());
$('#dlg-clips').addEventListener('close', () => $('#clips-player').pause());
$('#dlg-clips').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // clique fora fecha
});
$('#clips-filter').addEventListener('click', (e) => {
  const filter = e.target.closest('button')?.dataset.filter;
  if (!filter) return;
  clipsView.filter = filter;
  renderClipsDialog();
});

function renderClipList(list, clips, options) {
  if (!clips.length) {
    const li = document.createElement('li');
    li.className = 'empty-clips';
    li.textContent = options.empty;
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...clips.map((clip) => clipCard(clip, options)));
}

// Editar um clipe já publicado (o Discord não recebe de novo)
let editDone = null;
function openEditDialog(clip, onChange) {
  editingClip = null;
  editDone = { clip, onChange };
  // No perfil, o clipe pode ser de outro canal: o @ sugere os membros de lá
  state.mentionChannel = clip.channel && clip.channel.id !== state.channel?.id ? clip.channel.id : null;
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
  show('view-profile');
  $('#profile-back').href = state.channel ? `/c/${state.channel.id}` : '/';
  $('#profile-back').textContent = !state.room ? '← Voltar'
    : state.local || myAppStream() ? '← Voltar pra sala (você está ao vivo)' : '← Voltar pra sala';
  $('#profile-name').textContent = 'Carregando…';
  $('#profile-username').textContent = `@${username}`;
  $('#profile-channels').textContent = '';
  $('#profile-clips').replaceChildren();
  try {
    profileData = await api(`/api/users/${encodeURIComponent(username)}`);
  } catch (err) {
    $('#profile-name').textContent = 'Perfil não encontrado';
    $('#profile-channels').textContent = err.message;
    return;
  }
  const { user, channels } = profileData;
  document.title = `${user.name} • Faz o L`;
  $('#profile-name').textContent = user.name;
  $('#profile-avatar').src = user.avatar || '';
  $('#profile-avatar').hidden = !user.avatar;
  $('#profile-channels').textContent = channels.length ? `Canais em comum: ${channels.map((c) => c.name).join(', ')}` : '';
  $('#count-streamed').textContent = `(${profileData.streamed.length})`;
  $('#count-tagged').textContent = `(${profileData.tagged.length})`;
  renderProfileTab();
}

function renderProfileTab() {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === profileTab);
  const me = profileData.me;
  const empty = profileTab === 'streamed'
    ? (me ? 'Ninguém clipou suas lives ainda.' : 'Ninguém clipou as lives dessa pessoa ainda.')
    : (me ? 'Ninguém te marcou em clipes ainda.' : 'Essa pessoa ainda não foi marcada em clipes.');
  renderClipList($('#profile-clips'), profileData[profileTab], {
    empty,
    showChannel: true,
    onChange: () => showProfile(profileData.user.username),
  });
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    profileTab = tab.dataset.tab;
    if (profileData) renderProfileTab();
  });
}

// ---------------- gerenciar canal (dono) ----------------

$('#btn-manage').addEventListener('click', openManage);
$('#manage-close').addEventListener('click', () => $('#dlg-manage').close());

async function openManage() {
  $('#manage-name').textContent = state.channel.name;
  $('#dlg-manage').showModal();
  loadInvites();
  loadMembers();
  loadDiscordChannels();
}

async function loadInvites() {
  try {
    const { invites } = await api(ch('/invites'));
    const list = $('#invite-list');
    if (!invites.length) {
      list.innerHTML = '<li class="muted">Nenhum convite ativo.</li>';
      return;
    }
    list.replaceChildren(
      ...invites.map((inv) => {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.className = 'grow';
        const expires = inv.expiresAt ? `expira ${new Date(inv.expiresAt).toLocaleDateString('pt-BR')}` : 'não expira';
        const uses = inv.maxUses ? `${inv.uses}/${inv.maxUses} usos` : `${inv.uses} usos`;
        text.textContent = `${inv.url.replace(/^https?:\/\//, '')} • ${expires} • ${uses}`;
        const copy = document.createElement('button');
        copy.textContent = 'Copiar';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(inv.url);
            toast('Link de convite copiado!');
          } catch {
            prompt('Copie o convite:', inv.url);
          }
        });
        const revoke = document.createElement('button');
        revoke.textContent = 'Revogar';
        revoke.className = 'danger';
        revoke.addEventListener('click', async () => {
          await api(ch(`/invites/${inv.code}`), { method: 'DELETE' }).catch((err) => toast(err.message, true));
          loadInvites();
        });
        li.append(text, copy, revoke);
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
      () => toast('Convite criado e copiado! Cole no Discord.'),
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
  $('#members-count').textContent = `(${members.length})`;
  $('#member-list').replaceChildren(
    ...members.map((m) => {
      const li = document.createElement('li');
      if (m.avatar) {
        const img = document.createElement('img');
        img.src = m.avatar;
        img.alt = '';
        li.append(img);
      } else {
        const span = document.createElement('span');
        span.className = 'avatar';
        span.textContent = m.name.slice(0, 1).toUpperCase();
        li.append(span);
      }
      const name = document.createElement('span');
      name.className = 'grow';
      name.textContent = `${m.name}${m.username ? ` (@${m.username})` : ''}${m.role === 'owner' ? ' • dono' : ''}`;
      li.append(name);
      if (m.role !== 'owner') {
        const remove = document.createElement('button');
        remove.textContent = 'Remover';
        remove.className = 'danger';
        remove.addEventListener('click', async () => {
          if (!confirm(`Remover ${m.name} do canal? A pessoa só volta com um convite novo.`)) return;
          await api(ch(`/members/${m.id}`), { method: 'DELETE' }).catch((err) => toast(err.message, true));
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
    notify.replaceChildren(...options(data.notifyChannelId, 'Não avisar'));
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
      toast('Canais do Discord salvos.');
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
  $('#opt-quality').innerHTML = `
    <option value="1440p60">1440p • 60 fps (rede forte)</option>
    <option value="1080p60">1080p • 60 fps (recomendado)</option>
    <option value="1080p30">1080p • 30 fps</option>
    <option value="720p60">720p • 60 fps</option>
    <option value="720p30">720p • 30 fps (internet fraca)</option>`;
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
// Cada botão tem uma duração (menu ✂ Clipar) e, no app desktop, um atalho global.
// Fica salvo neste aparelho.

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

function fillClipMenu(menu) {
  menu.replaceChildren(...clipSlots().map(({ seconds }) => {
    const b = document.createElement('button');
    b.dataset.seconds = String(seconds);
    b.textContent = `Últimos ${lengthLabel(seconds)}`;
    return b;
  }));
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

function renderClipSettings() {
  const list = $('#clip-slots');
  if (!list) return;
  const slots = clipSlots();
  const withKeys = desktop && hotkeysSupported;
  $('#clip-settings-hint').textContent = !desktop
    ? 'Durações do menu ✂ Clipar. No app desktop dá pra pôr um atalho em cada uma (funciona dentro do jogo).'
    : hotkeysSupported
      ? 'Durações do ✂ Clipar e atalhos que funcionam até dentro do jogo. Clique no atalho e aperte qualquer tecla ou combinação. Tecla sozinha (sem Ctrl/Alt) para de digitar nos outros programas enquanto o app estiver aberto.'
      : 'Atualize o app para trocar os atalhos (por enquanto: Ctrl+F9, Ctrl+F10 e Ctrl+F11).';
  list.replaceChildren(...slots.map((slot, i) => {
    const li = document.createElement('li');
    li.className = 'clip-slot';

    const select = document.createElement('select');
    select.title = 'Duração do clipe';
    for (const s of CLIP_DURATIONS) {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = lengthLabel(s);
      select.append(o);
    }
    select.value = String(slot.seconds);
    select.addEventListener('change', () => {
      slots[i].seconds = Number(select.value);
      saveClipSlots(slots);
    });
    li.append(select);

    if (withKeys) {
      const key = document.createElement('button');
      key.type = 'button';
      key.className = 'clip-key';
      const error = slot.key && hotkeyErrors[slot.key];
      key.classList.toggle('error', !!error);
      key.classList.toggle('waiting', capturing === i);
      key.textContent = capturing === i ? 'Aperte as teclas…' : slot.key ? keyLabel(slot.key) : 'Sem atalho';
      key.title = error ? `Não funcionou: ${error}` : 'Clique e aperte o atalho (Esc cancela, Backspace remove)';
      key.addEventListener('click', () => startCapture(i));
      li.append(key);
      if (error) {
        const warn = document.createElement('span');
        warn.className = 'clip-key-error';
        warn.textContent = error;
        li.append(warn);
      }
    }
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
    if (!shortcut) return; // só modificador ainda, ou tecla sem Ctrl/Alt/Shift
    // Mesmo atalho em outro botão: tira de lá
    for (const s of slots) if (s.key === shortcut) s.key = '';
    slots[capturing].key = shortcut;
  }
  capturing = null;
  saveClipSlots(slots);
}, true);

// Configurações (ícone na barra da esquerda): botões de clipe e atualização do app
$('#btn-settings').addEventListener('click', () => {
  renderClipSettings();
  $('#dlg-settings').showModal();
});
$('#settings-close').addEventListener('click', () => $('#dlg-settings').close());
$('#dlg-settings').addEventListener('close', () => {
  if (capturing !== null) {
    capturing = null;
    applyClipHotkeys();
  }
});

$('#clip-settings-reset').addEventListener('click', () => {
  capturing = null;
  store.set('clip-slots', 'null');
  renderClipSettings();
  applyClipHotkeys();
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
  if (state.focus && state.tiles.has(state.focus) && !state.tiles.get(state.focus).isEvent) id = state.focus;
  else if (lives.length === 1) id = lives[0].id;
  return id === '__local__' ? state.me.id : id;
}

async function hotkeyClip(seconds) {
  if (!state.room || hotkeyBusy) return;
  const streamer = clipTarget();
  if (!streamer) return toast('Atalho de clipe: coloque uma live em destaque (⤢) para saber qual clipar.', true);
  hotkeyBusy = true;
  toast(`✂ Gerando clipe dos últimos ${lengthLabel(seconds)}…`);
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

function loadYouTubeApi() {
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
    return;
  }
  if (!before) toast(`🎬 Evento: ${ev.data.title}`);
  const tile = ensureEventTile();
  renderEventTile(tile);
  ensureEventPlayer().then(() => syncEventPlayer(true)).catch((err) => toast(err.message, true));
}

function ensureEventTile() {
  let tile = state.tiles.get(EVENT_TILE);
  if (tile) return tile;
  const el = document.createElement('div');
  el.className = 'tile tile-event has-video';
  el.innerHTML = `
    <div class="event-player"><div></div></div>
    <div class="event-shield"></div>
    <div class="tile-top">
      <span class="badge-live badge-event">EVENTO</span>
      <span class="tile-name"></span>
    </div>
    <div class="tile-controls">
      <div class="ctl-group">
        <button class="ctl ctl-mute" title="Mutar/desmutar">🔇</button>
        <input class="ctl-volume" type="range" min="0" max="100" step="1" title="Volume" />
      </div>
      <button class="ctl ev-play" title="Tocar/pausar pra todo mundo">⏸</button>
      <input class="ev-seek" type="range" min="0" max="0" step="1" value="0" title="Pular pra todo mundo" />
      <span class="ev-time"></span>
      <span class="spacer"></span>
      <button class="ctl ev-stop" title="Encerrar o evento pra todo mundo">■ Encerrar</button>
      <button class="ctl ctl-focus" title="Destacar">⤢</button>
      <button class="ctl ctl-full" title="Tela cheia">⛶</button>
    </div>`;
  tile = { id: EVENT_TILE, el, isEvent: true, video: null, publication: null };

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
  el.querySelector('.ctl-focus').addEventListener('click', () => {
    state.focus = state.focus === EVENT_TILE ? null : EVENT_TILE;
    layout();
  });
  el.querySelector('.ctl-full').addEventListener('click', () => toggleFullscreen(el));
  el.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tile-controls')) toggleFullscreen(el);
  });
  el.addEventListener('touchstart', () => {
    el.classList.add('touch');
    clearTimeout(tile.touchTimer);
    tile.touchTimer = setTimeout(() => el.classList.remove('touch'), 3500);
  }, { passive: true });

  state.tiles.set(EVENT_TILE, tile);
  $('#stage').prepend(el);
  layout();
  return tile;
}

function renderEventTile(tile) {
  const d = ev.data;
  const control = canControlEvent();
  tile.el.querySelector('.tile-name').textContent = `${d.title} • ${d.by.name}`;
  tile.el.querySelector('.ev-play').hidden = !control;
  tile.el.querySelector('.ev-play').textContent = d.playing ? '⏸' : '▶';
  tile.el.querySelector('.ev-seek').hidden = !control || isEventLive();
  tile.el.querySelector('.ev-stop').hidden = !control;
  tile.el.classList.toggle('paused', !d.playing);
}

function isEventLive() {
  const p = ev.player;
  if (!p || !ev.ready) return false;
  return !!p.getVideoData?.()?.isLive;
}

async function ensureEventPlayer() {
  const YT = await loadYouTubeApi();
  const tile = state.tiles.get(EVENT_TILE);
  if (!tile || !ev.data) return;
  if (ev.player && ev.videoId === ev.data.videoId) return;
  ev.videoId = ev.data.videoId;
  if (ev.player && ev.ready) {
    ev.player.loadVideoById({ videoId: ev.videoId, startSeconds: eventTarget(ev.data) });
    return;
  }
  ev.ready = false;
  const holder = tile.el.querySelector('.event-player > div');
  await new Promise((resolve) => {
    ev.player = new YT.Player(holder, {
      width: '100%',
      height: '100%',
      videoId: ev.videoId,
      playerVars: {
        autoplay: 1, mute: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3,
        start: Math.floor(eventTarget(ev.data)),
      },
      events: {
        onReady: () => {
          ev.ready = true;
          applyEventVolume();
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
  clearInterval(ev.timer);
  ev.timer = setInterval(() => {
    syncEventPlayer(false);
    renderEventTime();
  }, 1000);
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
function syncEventPlayer(force) {
  const p = ev.player;
  const d = ev.data;
  if (!p || !ev.ready || !d || !window.YT) return;
  const S = window.YT.PlayerState;
  const st = p.getPlayerState();
  const live = isEventLive();
  if (d.playing) {
    if (st === S.PAUSED || st === S.CUED || st === S.UNSTARTED) p.playVideo();
    if (!live && st !== S.ENDED) {
      const target = eventTarget(d);
      const duration = p.getDuration() || Infinity;
      const drift = p.getCurrentTime() - target;
      // Internet lenta: não fica pulando sem parar (no máximo a cada 4 s)
      if (target < duration && (force || (Math.abs(drift) > 1.5 && Date.now() - lastHardSync > 4000))) {
        lastHardSync = Date.now();
        p.seekTo(target, true);
      }
    }
  } else {
    if (st === S.PLAYING || st === S.BUFFERING) p.pauseVideo();
    if (!live && (force || Math.abs(p.getCurrentTime() - d.position) > 0.5)) p.seekTo(d.position, true);
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
    time.textContent = '🔴 AO VIVO';
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
  if (tile) tile.el.querySelector('.ctl-mute').textContent = ev.muted || ev.volume === 0 ? '🔇' : '🔊';
  const p = ev.player;
  if (!p || !ev.ready) return;
  p.setVolume(ev.volume);
  if (ev.muted || ev.volume === 0) p.mute();
  else p.unMute();
}

async function controlEvent(action, position) {
  try {
    const body = { action };
    if (position !== undefined) body.position = position;
    else if (ev.player && ev.ready && !isEventLive()) body.position = ev.player.getCurrentTime();
    const res = await api(ch('/event'), { method: 'PATCH', body });
    applyEvent(res.event);
  } catch (err) {
    toast(err.message, true);
  }
}

async function stopEvent() {
  if (!confirm('Encerrar o evento pra todo mundo?')) return;
  try {
    await api(ch('/event'), { method: 'DELETE' });
    applyEvent(null);
  } catch (err) {
    toast(err.message, true);
  }
}

// Começar evento (painel Transmitir → "Começar evento do YouTube")
$('#btn-event').addEventListener('click', () => {
  if (ev.data && !canControlEvent()) return toast(`Já tem um evento rolando (de ${ev.data.by.name}).`, true);
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
