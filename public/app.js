import { decodeSubtitleBuffer, parseSubtitleText } from './subtitles.js';

const NICKNAME_KEY = 'watch-together:nickname';
const VOLUME_KEY = 'watch-together:volume';
const DANMAKU_KEY = 'watch-together:danmaku';
const HOST_KEY_PREFIX = 'watch-together:host:';
const ROOM_ID_RE = /^[a-z0-9]{8}$/;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
const MAX_RECONNECT_DELAY = 15_000;
const AVATAR_COLORS = [
  ['#f2b56b', '#c68745'],
  ['#e8a087', '#b56e59'],
  ['#b8c5a6', '#7e956c'],
  ['#b9b2dc', '#857cad'],
  ['#e5c69c', '#b78d5a'],
  ['#9fc5c1', '#6d9b96'],
  ['#d8c1a8', '#aa8d72'],
];

const els = {};
const state = {
  roomId: null,
  room: null,
  hostKey: null,
  name: '',
  role: null,
  selfId: null,
  members: [],
  hostOnline: false,
  memberCount: 0,
  ws: null,
  joined: false,
  everJoined: false,
  leaving: false,
  fatal: false,
  roomClosed: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  sync: null,
  clockOffset: 0,
  clockSynced: false,
  guestActive: false,
  guestBuffering: false,
  playBlocked: false,
  playAttempt: null,
  sourceLoaded: false,
  sourceReady: false,
  sourceUrl: '',
  compat: {
    active: false,
    url: '',
  },
  hls: null,
  hostBuffering: false,
  applyingRemote: false,
  remoteTimer: null,
  seekingByUser: false,
  pendingHostSeek: null,
  videoError: false,
  heartbeatTimer: null,
  pingTimer: null,
  syncTimer: null,
  volume: 0.8,
  curtainAction: null,
  controls: {
    hideTimer: null,
    hidden: false,
    pinned: false,
    wasHiddenWhenPressed: false,
  },
  chat: {
    messages: [],
    danmakuEnabled: true,
    queue: [],
    laneFreeAt: [],
    pumpTimer: null,
  },
  subtitle: {
    mode: 'off',
    active: null,
    external: [],
    native: [],
    hls: [],
    panelOpen: false,
    loading: false,
    signature: '',
    idCounter: 0,
    embedded: {
      status: 'idle',
      tracks: [],
      error: '',
      loadingId: null,
    },
  },
};

function qs(selector) {
  return document.querySelector(selector);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式下 localStorage 可能不可用，不影响本次播放。
  }
}

function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // 忽略。
  }
}

function hostKeyStorageName(roomId) {
  return `${HOST_KEY_PREFIX}${roomId}`;
}

class ApiError extends Error {
  constructor(message, status = 0, code = 'NETWORK_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body,
    });
  } catch {
    throw new ApiError('无法连接服务器，请检查网络后再试。');
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 错误也统一处理。
  }
  if (!response.ok) {
    throw new ApiError(
      data?.error?.message || `请求失败（${response.status}）`,
      response.status,
      data?.error?.code || 'REQUEST_FAILED',
    );
  }
  return data;
}

function init() {
  cacheElements();
  bindEvents();
  restorePreferences();

  const roomId = new URLSearchParams(window.location.search).get('room');
  if (roomId) {
    enterRoom(roomId);
  } else {
    showView('landing');
  }
}

function cacheElements() {
  const ids = [
    'landing-view',
    'join-view',
    'room-view',
    'create-form',
    'video-url',
    'room-title',
    'host-name',
    'create-error',
    'create-button',
    'join-form',
    'join-name',
    'join-error',
    'join-button',
    'join-title',
    'join-byline',
    'join-source',
    'join-members',
    'join-host-state',
    'join-details',
    'join-missing',
    'room-code-label',
    'copy-code',
    'connection-state',
    'connection-text',
    'member-count',
    'avatar-stack',
    'leave-button',
    'room-status',
    'room-status-text',
    'host-presence',
    'player-curtain',
    'curtain-kicker',
    'curtain-title',
    'curtain-text',
    'curtain-button',
    'player-spinner',
    'spinner-text',
    'player-error',
    'player-error-text',
    'retry-source',
    'compat-source',
    'player-shell',
    'player-bottom',
    'player-topline',
    'subtitle-overlay',
    'subtitle-button',
    'subtitle-panel',
    'subtitle-close',
    'subtitle-list',
    'subtitle-form',
    'subtitle-url',
    'subtitle-add',
    'subtitle-error',
    'chat-messages',
    'chat-form',
    'chat-input',
    'chat-send',
    'danmaku-toggle',
    'danmaku-layer',
    'video',
    'seek-range',
    'play-toggle',
    'current-time',
    'duration-time',
    'mute-toggle',
    'volume-range',
    'sync-indicator',
    'sync-text',
    'speed-button',
    'fullscreen-button',
    'room-heading',
    'role-badge',
    'room-byline',
    'copy-invite',
    'side-code',
    'side-members',
    'side-role',
    'copy-invite-2',
    'side-presence',
    'member-list',
    'footer-room',
    'toast-region',
  ];
  for (const id of ids) {
    els[toCamel(id)] = document.getElementById(id);
  }
}

function toCamel(value) {
  return value.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
}

function bindEvents() {
  els.createForm.addEventListener('submit', onCreateRoom);
  els.joinForm.addEventListener('submit', onJoinRoom);
  els.leaveButton.addEventListener('click', leaveRoom);
  els.copyCode.addEventListener('click', copyInvite);
  els.copyInvite.addEventListener('click', copyInvite);
  els.copyInvite2.addEventListener('click', copyInvite);
  els.curtainButton.addEventListener('click', onCurtainAction);
  els.playToggle.addEventListener('click', togglePlayback);
  els.retrySource.addEventListener('click', retrySource);
  els.compatSource.addEventListener('click', startCompatibilityMode);
  els.muteToggle.addEventListener('click', toggleMute);
  els.speedButton.addEventListener('click', cycleSpeed);
  els.fullscreenButton.addEventListener('click', toggleFullscreen);
  els.subtitleButton.addEventListener('click', () => {
    setSubtitlePanel(!state.subtitle.panelOpen);
  });
  els.subtitleClose.addEventListener('click', () => setSubtitlePanel(false));
  els.subtitleForm.addEventListener('submit', onAddSubtitle);
  els.chatForm.addEventListener('submit', onSendChat);
  els.chatInput.addEventListener('input', refreshChatSendButton);
  els.danmakuToggle.addEventListener('click', toggleDanmaku);

  els.playerShell.addEventListener('pointermove', () => showPlayerControls(), {
    passive: true,
  });
  els.playerShell.addEventListener('pointerdown', () => showPlayerControls(), {
    passive: true,
  });
  els.playerShell.addEventListener('pointerleave', scheduleControlsHide, {
    passive: true,
  });
  els.playerBottom.addEventListener('pointerdown', () => {
    state.controls.pinned = true;
    showPlayerControls();
  });
  els.playerBottom.addEventListener('focusin', () => {
    state.controls.pinned = true;
    showPlayerControls();
  });
  els.playerBottom.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (
        !els.playerBottom.contains(document.activeElement) &&
        !els.subtitlePanel.contains(document.activeElement)
      ) {
        state.controls.pinned = false;
        scheduleControlsHide();
      }
    }, 0);
  });
  document.addEventListener('pointerup', () => {
    if (state.controls.pinned) {
      state.controls.pinned = false;
      scheduleControlsHide();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!state.subtitle.panelOpen) return;
    const target = event.target;
    if (
      els.subtitlePanel.contains(target) ||
      els.subtitleButton.contains(target)
    ) {
      return;
    }
    setSubtitlePanel(false);
    if (els.playerShell.contains(target)) {
      state.controls.wasHiddenWhenPressed = true;
      window.setTimeout(() => {
        state.controls.wasHiddenWhenPressed = false;
      }, 350);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.subtitle.panelOpen) {
      setSubtitlePanel(false);
    }
  });
  window.addEventListener('resize', () => {
    updateSubtitleOverlayBounds();
    showPlayerControls();
  });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => updateSubtitleOverlayBounds());
    observer.observe(els.playerShell);
    state.resizeObserver = observer;
  }
  if (els.video.textTracks?.addEventListener) {
    els.video.textTracks.addEventListener('addtrack', () => {
      scanNativeTracks();
      if (state.subtitle.panelOpen) renderSubtitleList();
    });
  }
  window.setInterval(updateSubtitleOverlay, 120);

  els.volumeRange.addEventListener('input', () => {
    const volume = Number(els.volumeRange.value) / 100;
    els.video.volume = volume;
    els.video.muted = volume === 0;
    state.volume = volume;
    storageSet(VOLUME_KEY, String(volume));
    updateVolumeUi();
  });

  els.seekRange.addEventListener('pointerdown', () => {
    if (state.role === 'host') state.seekingByUser = true;
  });
  els.seekRange.addEventListener('input', () => {
    if (state.role !== 'host') return;
    state.seekingByUser = true;
    const duration = getDuration();
    const fraction = Number(els.seekRange.value) / 1_000;
    if (duration > 0) {
      els.currentTime.textContent = formatTime(fraction * duration);
      setSeekFill(fraction * 100);
    }
  });
  els.seekRange.addEventListener('change', () => {
    if (state.role !== 'host') return;
    const duration = getDuration();
    if (duration > 0) {
      els.video.currentTime = clamp(
        (Number(els.seekRange.value) / 1_000) * duration,
        0,
        duration,
      );
    }
    state.seekingByUser = false;
  });

  const video = els.video;
  video.addEventListener('loadedmetadata', onLoadedMetadata);
  video.addEventListener('canplay', onCanPlay);
  video.addEventListener('playing', onVideoPlaying);
  video.addEventListener('play', onVideoPlay);
  video.addEventListener('pause', onVideoPause);
  video.addEventListener('waiting', onVideoWaiting);
  video.addEventListener('stalled', onVideoWaiting);
  video.addEventListener('seeked', onVideoSeeked);
  video.addEventListener('ratechange', onVideoRateChange);
  video.addEventListener('ended', onVideoEnded);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('durationchange', refreshTimeline);
  video.addEventListener('resize', updateSubtitleOverlayBounds);
  video.addEventListener('volumechange', updateVolumeUi);
  video.addEventListener('error', onVideoError);
  video.addEventListener('pointerdown', () => {
    state.controls.wasHiddenWhenPressed = state.controls.hidden;
    showPlayerControls();
    window.setTimeout(() => {
      state.controls.wasHiddenWhenPressed = false;
    }, 500);
  });
  video.addEventListener('click', () => {
    if (state.controls.wasHiddenWhenPressed) {
      state.controls.wasHiddenWhenPressed = false;
      return;
    }
    if (state.role === 'host' && state.joined && state.sourceReady) {
      togglePlayback();
    }
  });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('fullscreenchange', () => {
    updateFullscreenButton();
    updateSubtitleOverlayBounds();
    showPlayerControls();
  });
  window.addEventListener('online', () => {
    if (state.roomId && !state.ws && !state.fatal && !state.leaving) {
      clearReconnectTimer();
      connectSocket();
    }
  });
  window.addEventListener('popstate', () => window.location.reload());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.role === 'host' && state.joined && state.sourceReady) {
      sendHostState('heartbeat');
    }
    if (state.role === 'guest') synchronizeGuest();
  });
}

function restorePreferences() {
  const nickname = storageGet(NICKNAME_KEY);
  if (nickname) {
    els.hostName.value = nickname;
    els.joinName.value = nickname;
  }

  const storedVolume = storageGet(VOLUME_KEY);
  const savedVolume = storedVolume === null ? Number.NaN : Number(storedVolume);
  state.volume = Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1
    ? savedVolume
    : 0.8;
  els.video.volume = state.volume;
  els.volumeRange.value = String(Math.round(state.volume * 100));
  updateVolumeUi();

  const danmaku = storageGet(DANMAKU_KEY);
  state.chat.danmakuEnabled = danmaku === null ? true : danmaku !== '0';
  updateDanmakuToggle();
  refreshChatState();
  renderChatMessages();
}

function showView(name) {
  for (const view of ['landing', 'join', 'room']) {
    const element = document.getElementById(`${view}-view`);
    element.hidden = view !== name;
  }
  document.body.dataset.view = name;
  if (name === 'landing') {
    document.title = '一起看 · 同步放映厅';
  }
  window.scrollTo(0, 0);
}

async function enterRoom(rawRoomId) {
  const roomId = String(rawRoomId || '').trim().toLowerCase();
  showView('join');
  setJoinLoading();

  if (!ROOM_ID_RE.test(roomId)) {
    showJoinMissing('邀请链接不完整，请向房主重新索取链接。');
    return;
  }

  state.roomId = roomId;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    state.room = data.room;
  } catch (error) {
    showJoinMissing(
      error.status === 404
        ? '这个房间不存在，或已经散场。'
        : error.message || '无法读取房间信息。',
    );
    return;
  }

  renderJoin(state.room);

  const savedHostKey = storageGet(hostKeyStorageName(roomId));
  if (savedHostKey) {
    state.hostKey = savedHostKey;
    state.name =
      storageGet(NICKNAME_KEY) || state.room.hostName || '房主';
    beginConnection();
    return;
  }

  state.hostKey = null;
  showView('join');
  window.setTimeout(() => {
    if (window.matchMedia('(min-width: 760px)').matches) els.joinName.focus();
  }, 60);
}

function setJoinLoading() {
  els.joinTitle.textContent = '正在读取房间…';
  els.joinByline.textContent = '请稍候，正在确认邀请是否有效。';
  els.joinSource.textContent = '—';
  els.joinMembers.textContent = '—';
  els.joinHostState.textContent = '—';
  els.joinForm.hidden = true;
  els.joinMissing.hidden = true;
  els.joinError.hidden = true;
  els.joinDetails.hidden = false;
  document.title = '正在加入 · 一起看';
}

function renderJoin(room) {
  showView('join');
  els.joinTitle.textContent = room.title;
  els.joinByline.textContent = `房主 ${room.hostName} 邀请你一起看 · ${sourceLabel(
    room.videoUrl,
  )}`;
  els.joinSource.textContent = sourceLabel(room.videoUrl);
  els.joinMembers.textContent = `${room.memberCount} 人`;
  els.joinHostState.textContent = room.hostOnline ? '在线' : '暂时离开';
  els.joinDetails.hidden = false;
  els.joinForm.hidden = false;
  els.joinMissing.hidden = true;
  els.joinError.hidden = true;
  els.joinButton.disabled = false;
  els.joinButton.querySelector('span').textContent = '加入放映厅';
  if (!els.joinName.value) {
    els.joinName.value = storageGet(NICKNAME_KEY) || '';
  }
  document.title = `${room.title} · 一起看`;
}

function showJoinMissing(message) {
  showView('join');
  els.joinTitle.textContent = '房间不在这里';
  els.joinByline.textContent = '也许链接已经过期，或者房间已经散场。';
  els.joinForm.hidden = true;
  els.joinDetails.hidden = true;
  els.joinMissing.hidden = false;
  els.joinError.hidden = true;
  const note = els.joinMissing.querySelector('p');
  if (note) note.textContent = message;
  document.title = '房间不存在 · 一起看';
}

function showJoinFailure(message) {
  renderJoin(state.room || {});
  els.joinError.textContent = message;
  els.joinError.hidden = false;
  els.joinButton.disabled = false;
  els.joinButton.querySelector('span').textContent = '重试加入';
  state.fatal = false;
  state.roomClosed = false;
  state.joined = false;
  state.role = state.hostKey ? 'host' : 'guest';
  setConnection('offline', '未连接');
  showView('join');
}

function beginConnection() {
  if (!state.roomId || !state.room) return;

  state.leaving = false;
  state.fatal = false;
  state.roomClosed = false;
  state.reconnectAttempts = 0;
  state.guestActive = false;
  state.playBlocked = false;
  state.hostBuffering = false;
  state.role = state.hostKey ? 'host' : 'guest';
  state.members = [];
  state.hostOnline = false;
  state.memberCount = 1;

  showView('room');
  renderRoomChrome();
  renderPresence();
  refreshControls();
  refreshChatState();
  setConnection('connecting', '连接中');
  showCurtain(
    'CONNECTING',
    '正在进入放映厅…',
    '连接成功后，画面会在这里出现。',
    null,
  );
  showPlayerControls();

  connectSocket();
}

function connectSocket() {
  if (!state.roomId || state.fatal || state.leaving) return;
  if (
    state.ws &&
    (state.ws.readyState === WebSocket.OPEN ||
      state.ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearReconnectTimer();
  setConnection('connecting', '连接中');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(state.roomId)}`,
    );
  } catch {
    scheduleReconnect();
    return;
  }

  state.ws = socket;
  state.joined = false;

  socket.addEventListener('open', () => {
    if (state.ws !== socket) return;
    const hello = { type: 'hello', name: state.name || '访客' };
    if (state.hostKey) hello.hostKey = state.hostKey;
    sendSocket(hello);
    setConnection('connecting', '正在加入');
  });

  socket.addEventListener('message', (event) => {
    if (state.ws !== socket) return;
    handleSocketMessage(event.data);
  });

  socket.addEventListener('close', (event) => {
    handleSocketClose(socket, event);
  });

  socket.addEventListener('error', () => {
    // 关闭事件会统一触发重连或错误提示。
  });
}

function sendSocket(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  try {
    state.ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function handleSocketMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'welcome':
      handleWelcome(message);
      break;
    case 'sync':
      handleSync(message);
      break;
    case 'chat':
      if (message.message) handleIncomingChat(message.message);
      break;
    case 'presence':
      handlePresence(message);
      break;
    case 'pong':
      handlePong(message);
      break;
    case 'room-closed':
      handleRoomClosed(message);
      break;
    case 'error':
      if (message.message) toast(message.message, 'error');
      break;
    default:
      break;
  }
}

function handleWelcome(message) {
  state.joined = true;
  state.everJoined = true;
  state.fatal = false;
  state.roomClosed = false;
  state.role = message.role === 'host' ? 'host' : 'guest';
  state.selfId = message.selfId;
  state.room = message.room;
  state.members = Array.isArray(message.members) ? message.members : [];
  state.hostOnline = Boolean(message.room.hostOnline);
  state.memberCount = message.room.memberCount || state.members.length;
  state.reconnectAttempts = 0;
  clearReconnectTimer();
  setConnection('online', '已连接');
  showPlayerControls();

  renderRoomChrome();
  renderPresence();
  setChatHistory(Array.isArray(message.chat) ? message.chat : []);
  refreshChatState();

  if (!state.sourceLoaded || state.sourceUrl !== effectiveSourceUrl()) {
    setupSource();
  }

  applyPlayback(message.room.playback, message.serverTime, 'welcome');
  startTimers();
  refreshControls();

  if (state.role === 'host') {
    state.pendingHostSeek = Number.isFinite(message.room.playback.position)
      ? message.room.playback.position
      : 0;
    if (state.sourceReady) applyHostBaseline();
  } else if (state.sourceReady) {
    synchronizeGuest({ force: true });
  }

  if (state.sourceReady) {
    if (state.role === 'host' || state.guestActive || !isEffectivePlaying()) {
      hideCurtain();
    }
  }
}

function handleSync(message) {
  if (!message.playback) return;
  const wasHostOnline = state.hostOnline;
  if (typeof message.hostOnline === 'boolean') {
    state.hostOnline = message.hostOnline;
  }
  if (Number.isFinite(message.memberCount)) {
    state.memberCount = message.memberCount;
    updateCounts();
  }

  applyPlayback(message.playback, message.serverTime, message.reason);
  if (message.reason === 'host-left' && state.role === 'guest') {
    toast('房主离开了房间，播放已在当前进度暂停。');
  } else if (message.reason === 'host-joined' && state.role === 'guest' && !wasHostOnline) {
    toast('房主回到了放映厅。');
  }

  if (state.role === 'guest' && state.sourceReady) {
    synchronizeGuest();
    if (isEffectivePlaying() && !state.guestActive && !state.fatal) {
      showGuestPrompt();
    }
  }
  refreshStatus();
  updateSyncIndicator();
}

function handlePresence(message) {
  if (Array.isArray(message.members)) state.members = message.members;
  if (typeof message.hostOnline === 'boolean') {
    state.hostOnline = message.hostOnline;
  }
  if (Number.isFinite(message.memberCount)) {
    state.memberCount = message.memberCount;
  } else {
    state.memberCount = state.members.length;
  }
  renderPresence();
  refreshStatus();
}

function handlePong(message) {
  const sentAt = Number(message.t);
  const serverTime = Number(message.serverTime);
  if (!Number.isFinite(sentAt) || !Number.isFinite(serverTime)) return;
  const rtt = Date.now() - sentAt;
  if (rtt < 0 || rtt > 5_000) return;
  const sample = serverTime - (sentAt + rtt / 2);
  if (state.clockSynced) {
    state.clockOffset = state.clockOffset * 0.7 + sample * 0.3;
  } else {
    state.clockOffset = sample;
    state.clockSynced = true;
  }
}

function handleRoomClosed(message) {
  if (state.subtitle.panelOpen) setSubtitlePanel(false);
  state.roomClosed = true;
  state.fatal = true;
  state.joined = false;
  refreshChatState();
  stopTimers();
  pauseVideoForDisconnect();
  setConnection('offline', '已结束');
  hideSpinner();
  els.playerError.hidden = true;
  showCurtain(
    'THE END',
    '放映结束',
    message.reason || '房主关闭了这间放映厅。',
    null,
  );
  showPlayerControls();
  refreshControls();
  refreshStatus();
  clearDanmaku();
  toast(message.reason || '房间已关闭', 'error');
}

function applyPlayback(playback, serverTime, reason) {
  state.sync = {
    position: Number(playback.position) || 0,
    playing: Boolean(playback.playing),
    buffering: Boolean(playback.buffering),
    rate: Number(playback.rate) || 1,
    duration: Number.isFinite(Number(playback.duration))
      ? Number(playback.duration)
      : 0,
    serverTime: Number(serverTime) || Date.now(),
    receivedAt: Date.now(),
    receivedPerf: performance.now(),
    reason: reason || '',
  };

  if (!isEffectivePlaying()) state.guestBuffering = false;
  refreshStatus();
  updateSyncIndicator();
  refreshTimeline();
  refreshSpeedLabel();
}

function startTimers() {
  stopTimers();
  sendPing();
  state.pingTimer = window.setInterval(sendPing, 10_000);
  state.heartbeatTimer = window.setInterval(() => {
    if (
      state.role === 'host' &&
      state.joined &&
      state.sourceReady &&
      !els.video.paused
    ) {
      sendHostState('heartbeat');
    }
  }, 2_500);
  state.syncTimer = window.setInterval(() => {
    if (state.role === 'guest') {
      synchronizeGuest();
      updateSyncIndicator();
    }
  }, 500);
}

function stopTimers() {
  if (state.pingTimer) window.clearInterval(state.pingTimer);
  if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
  if (state.syncTimer) window.clearInterval(state.syncTimer);
  state.pingTimer = null;
  state.heartbeatTimer = null;
  state.syncTimer = null;
}

function sendPing() {
  sendSocket({ type: 'ping', t: Date.now() });
}

function clearReconnectTimer() {
  if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function handleSocketClose(socket, event) {
  if (state.ws !== socket) return;
  if (state.subtitle.panelOpen) setSubtitlePanel(false);
  state.ws = null;
  state.joined = false;
  stopTimers();
  pauseVideoForDisconnect();
  state.hostBuffering = false;
  state.guestBuffering = false;
  refreshControls();
  refreshStatus();
  refreshChatState();

  if (state.leaving || state.fatal || state.roomClosed) return;

  setConnection('offline', '已断开');

  if (event.code === 4003) {
    storageRemove(hostKeyStorageName(state.roomId));
    state.hostKey = null;
    state.role = 'guest';
    state.guestActive = false;
    state.playBlocked = false;
    state.reconnectAttempts = 0;
    toast('房主凭证已失效，将以访客身份重新连接。', 'error');
    showReconnectCurtain('正在以访客身份重新连接…');
    scheduleReconnect(500);
    return;
  }

  if (event.code === 4004) {
    state.fatal = true;
    if (state.everJoined) {
      showCurtain('THE END', '房间已散场', '这间放映厅已经过期。', null);
    } else {
      showJoinMissing('这个房间不存在，或已经散场。');
    }
    return;
  }

  if (event.code === 4005) {
    state.fatal = true;
    if (state.everJoined) {
      showCurtain('ROOM FULL', '房间已满', '请等有人离开后再试。', null);
    } else {
      showJoinFailure('房间人数已满，请稍后再试。');
    }
    return;
  }

  if (event.code === 4009 || event.code === 1008 || event.code === 1009) {
    state.fatal = true;
    showCurtain('CONNECTION REFUSED', '连接被拒绝了', '刷新页面后再试一次。', null);
    toast('连接被服务器拒绝，请刷新页面。', 'error');
    return;
  }

  if (event.code === 4000) {
    state.fatal = true;
    showCurtain('THE END', '放映结束', '房主关闭了这间放映厅。', null);
    return;
  }

  showReconnectCurtain();
  scheduleReconnect();
}

function scheduleReconnect(delayOverride) {
  if (
    state.reconnectTimer ||
    state.fatal ||
    state.leaving ||
    state.roomClosed ||
    !state.roomId
  ) {
    return;
  }
  state.reconnectAttempts += 1;
  const delay =
    delayOverride ??
    Math.min(
      MAX_RECONNECT_DELAY,
      700 * 2 ** Math.min(state.reconnectAttempts - 1, 5),
    ) + Math.random() * 300;
  setConnection('offline', '重连中');
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    connectSocket();
  }, delay);
}

function showReconnectCurtain(text = '正在自动重连，播放已暂停…') {
  hideSpinner();
  showCurtain('CONNECTION LOST', '连接中断了', text, null);
}

/* ---------- 房间聊天 ---------- */

function refreshChatState() {
  if (!els.chatInput) return;
  const ready =
    state.joined &&
    state.ws?.readyState === WebSocket.OPEN &&
    !state.roomClosed &&
    !state.fatal;
  els.chatInput.disabled = !ready;
  els.chatInput.placeholder = ready
    ? '说点什么…'
    : state.roomClosed
      ? '放映已结束'
      : '连接后就能聊天…';
  refreshChatSendButton();
}

function refreshChatSendButton() {
  if (!els.chatSend) return;
  const ready =
    state.joined &&
    state.ws?.readyState === WebSocket.OPEN &&
    !state.roomClosed &&
    !state.fatal;
  els.chatSend.disabled = !ready || !els.chatInput.value.trim();
}

function formatChatTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function createChatMessageElement(message) {
  const item = document.createElement('li');
  item.className = 'chat-message';
  item.dataset.self = message.userId === state.selfId ? 'true' : 'false';
  item.dataset.role = message.role === 'host' ? 'host' : 'guest';

  const avatar = document.createElement('span');
  avatar.className = 'chat-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  decorateAvatar(avatar, { id: message.userId, name: message.name });
  item.append(avatar);

  const body = document.createElement('div');
  body.className = 'chat-message-body';

  const meta = document.createElement('div');
  meta.className = 'chat-message-meta';
  const name = document.createElement('span');
  name.className = 'chat-message-name';
  name.textContent = message.name || '访客';
  meta.append(name);
  if (message.role === 'host') meta.append(iconUse('i-crown'));
  if (message.userId === state.selfId) {
    const you = document.createElement('span');
    you.className = 'chat-you';
    you.textContent = '你';
    meta.append(you);
  }
  const time = document.createElement('time');
  time.className = 'chat-message-time';
  const date = new Date(Number(message.at));
  if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
  time.textContent = formatChatTime(message.at);
  meta.append(time);

  const text = document.createElement('p');
  text.className = 'chat-message-text';
  text.textContent = message.text;

  body.append(meta, text);
  item.append(body);
  return item;
}

function scrollChatToBottom() {
  const list = els.chatMessages;
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}

function renderChatMessages() {
  if (!els.chatMessages) return;
  els.chatMessages.replaceChildren();
  if (!state.chat.messages.length) {
    const empty = document.createElement('li');
    empty.className = 'chat-empty';
    empty.textContent = '还没有消息，打个招呼吧。';
    els.chatMessages.append(empty);
    return;
  }
  for (const message of state.chat.messages) {
    els.chatMessages.append(createChatMessageElement(message));
  }
  window.requestAnimationFrame(scrollChatToBottom);
}

function setChatHistory(messages) {
  state.chat.messages = (Array.isArray(messages) ? messages : [])
    .filter(
      (message) =>
        message &&
        typeof message.text === 'string' &&
        message.text.trim(),
    )
    .slice(-100);
  renderChatMessages();
  window.requestAnimationFrame(scrollChatToBottom);
}

function handleIncomingChat(message) {
  if (!message || typeof message.text !== 'string') return;
  if (state.chat.messages.some((item) => item.id === message.id)) return;
  state.chat.messages.push(message);
  if (state.chat.messages.length > 100) {
    state.chat.messages.splice(0, state.chat.messages.length - 100);
  }
  if (els.chatMessages.querySelector('.chat-empty')) {
    els.chatMessages.replaceChildren();
  }
  els.chatMessages.append(createChatMessageElement(message));
  while (els.chatMessages.children.length > 100) {
    els.chatMessages.firstElementChild?.remove();
  }
  scrollChatToBottom();
  if (state.chat.danmakuEnabled) enqueueDanmaku(message);
}

function onSendChat(event) {
  event.preventDefault();
  if (!state.joined || state.roomClosed || state.fatal) {
    toast('连接断开，暂时不能发送消息。', 'error');
    return;
  }
  const text = els.chatInput.value.trim();
  if (!text) return;
  if (!sendSocket({ type: 'chat', text })) {
    toast('发送失败，请检查网络连接。', 'error');
    return;
  }
  els.chatInput.value = '';
  refreshChatSendButton();
  els.chatInput.focus();
}

function updateDanmakuToggle() {
  if (!els.danmakuToggle) return;
  const enabled = state.chat.danmakuEnabled;
  els.danmakuToggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  els.danmakuToggle.dataset.active = enabled ? 'true' : 'false';
  els.danmakuToggle.title = enabled
    ? '关闭弹幕（聊天消息仍会保留）'
    : '开启弹幕';
}

function toggleDanmaku() {
  state.chat.danmakuEnabled = !state.chat.danmakuEnabled;
  storageSet(DANMAKU_KEY, state.chat.danmakuEnabled ? '1' : '0');
  updateDanmakuToggle();
  if (!state.chat.danmakuEnabled) {
    clearDanmaku();
    toast('弹幕已关闭，聊天室消息仍会保留。');
  } else {
    toast('弹幕已开启。');
  }
}

function clearDanmaku() {
  if (state.chat.pumpTimer) {
    window.clearTimeout(state.chat.pumpTimer);
    state.chat.pumpTimer = null;
  }
  state.chat.queue = [];
  state.chat.laneFreeAt = [];
  if (els.danmakuLayer) els.danmakuLayer.replaceChildren();
}

function danmakuText(text) {
  const characters = Array.from(text);
  return characters.length > 72
    ? `${characters.slice(0, 72).join('')}…`
    : text;
}

function enqueueDanmaku(message) {
  if (
    !state.chat.danmakuEnabled ||
    !state.joined ||
    !state.sourceReady ||
    !els.danmakuLayer ||
    els.danmakuLayer.clientWidth < 40 ||
    els.danmakuLayer.clientHeight < 40
  ) {
    return;
  }
  state.chat.queue.push(message);
  if (state.chat.queue.length > 30) state.chat.queue.shift();
  pumpDanmaku();
}

function pumpDanmaku() {
  if (state.chat.pumpTimer || !state.chat.queue.length) return;
  const layer = els.danmakuLayer;
  if (!layer || layer.clientWidth < 40) return;

  const laneCount = Math.min(
    7,
    Math.max(2, Math.floor(layer.clientHeight / 38)),
  );
  if (state.chat.laneFreeAt.length !== laneCount) {
    state.chat.laneFreeAt = Array.from({ length: laneCount }, () => 0);
  }
  const now = performance.now();
  let lane = state.chat.laneFreeAt.findIndex((freeAt) => freeAt <= now);

  if (lane < 0) {
    const wait = Math.min(...state.chat.laneFreeAt) - now;
    state.chat.pumpTimer = window.setTimeout(() => {
      state.chat.pumpTimer = null;
      pumpDanmaku();
    }, Math.max(40, Math.min(wait + 20, 1_500)));
    return;
  }

  const message = state.chat.queue.shift();
  if (!message) return;
  spawnDanmaku(message, lane, laneCount);
  if (state.chat.queue.length) {
    state.chat.pumpTimer = window.setTimeout(() => {
      state.chat.pumpTimer = null;
      pumpDanmaku();
    }, 40);
  }
}

function spawnDanmaku(message, lane, laneCount) {
  const layer = els.danmakuLayer;
  const item = document.createElement('div');
  item.className = 'danmaku-item';
  item.dataset.self = message.userId === state.selfId ? 'true' : 'false';
  item.dataset.role = message.role === 'host' ? 'host' : 'guest';

  const name = document.createElement('span');
  name.className = 'danmaku-name';
  name.textContent = `${message.name || '访客'}：`;
  const text = document.createElement('span');
  text.className = 'danmaku-text';
  text.textContent = danmakuText(message.text);
  item.append(name, text);

  const laneHeight = Math.min(
    46,
    Math.max(30, layer.clientHeight / (laneCount + 0.8)),
  );
  item.style.top = `${7 + lane * laneHeight}px`;
  item.style.transform = `translateX(${layer.clientWidth}px)`;
  layer.append(item);

  const itemWidth = item.offsetWidth || 180;
  const distance = layer.clientWidth + itemWidth;
  const duration = Math.max(7_000, Math.min(16_000, (distance / 95) * 1_000));

  if (typeof item.animate === 'function') {
    const animation = item.animate(
      [
        { transform: `translateX(${layer.clientWidth}px)` },
        { transform: `translateX(-${itemWidth}px)` },
      ],
      { duration, easing: 'linear', fill: 'forwards' },
    );
    animation.onfinish = () => item.remove();
    animation.oncancel = () => item.remove();
  } else {
    item.style.transition = `transform ${duration}ms linear`;
    window.requestAnimationFrame(() => {
      item.style.transform = `translateX(-${itemWidth}px)`;
    });
    window.setTimeout(() => item.remove(), duration + 100);
  }

  const speed = distance / (duration / 1_000);
  state.chat.laneFreeAt[lane] =
    performance.now() + (layer.clientWidth / speed) * 1_000 + 240;
}


const CONTROLS_HIDE_DELAY = 2_600;

function shouldKeepControlsVisible() {
  let focusVisible = false;
  try {
    focusVisible =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.matches?.(':focus-visible') &&
      els.playerBottom.contains(document.activeElement);
  } catch {
    focusVisible = false;
  }
  return (
    !state.joined ||
    !state.sourceReady ||
    els.video.paused ||
    els.video.ended ||
    state.hostBuffering ||
    state.guestBuffering ||
    state.controls.pinned ||
    state.subtitle.panelOpen ||
    focusVisible ||
    !els.playerCurtain.hidden
  );
}

function showPlayerControls() {
  if (state.controls.hideTimer) {
    window.clearTimeout(state.controls.hideTimer);
    state.controls.hideTimer = null;
  }
  state.controls.hidden = false;
  els.playerShell.classList.remove('is-controls-hidden');
  scheduleControlsHide();
}

function scheduleControlsHide() {
  if (state.controls.hideTimer) {
    window.clearTimeout(state.controls.hideTimer);
    state.controls.hideTimer = null;
  }
  if (shouldKeepControlsVisible()) return;
  state.controls.hideTimer = window.setTimeout(() => {
    state.controls.hideTimer = null;
    if (shouldKeepControlsVisible()) return;
    state.controls.hidden = true;
    els.playerShell.classList.add('is-controls-hidden');
  }, CONTROLS_HIDE_DELAY);
}

function pauseVideoForDisconnect() {
  showPlayerControls();
  if (!els.video.paused) {
    setRemote(() => els.video.pause());
  }
}

function setConnection(status, text) {
  els.connectionState.dataset.state = status;
  els.connectionText.textContent = text;
}

function renderRoomChrome() {
  const room = state.room;
  if (!room) return;
  els.roomHeading.textContent = room.title;
  els.roomByline.textContent = `房主 ${room.hostName} · ${sourceLabel(
    room.videoUrl,
  )}`;
  const code = formatRoomCode(state.roomId);
  els.roomCodeLabel.textContent = code;
  els.sideCode.textContent = `ROOM ${state.roomId.toUpperCase()}`;
  els.footerRoom.textContent = `ROOM ${state.roomId.toUpperCase()}`;
  els.roleBadge.textContent = state.role === 'host' ? '房主' : '访客';
  els.roleBadge.dataset.role = state.role || 'guest';
  els.sideRole.textContent = state.role === 'host' ? '房主' : '访客';
  document.title = `${room.title} · 一起看`;
  refreshStatus();
}

function renderPresence() {
  const members = state.members.length
    ? state.members
    : state.selfId
      ? [{ id: state.selfId, name: state.name || '我', role: state.role || 'guest' }]
      : [];
  state.memberCount = Math.max(state.memberCount || 0, members.length);

  updateCounts();
  renderAvatarStack(members);
  renderMemberList(els.memberList, members);
  els.sidePresence.textContent = String(members.length);
  refreshStatus();
}

function updateCounts() {
  const count = Math.max(state.memberCount || 0, state.members.length);
  els.memberCount.textContent = `${count} 人在场`;
  els.sideMembers.textContent = String(count);
}

function renderAvatarStack(members) {
  els.avatarStack.replaceChildren();
  const visible = members.slice(0, 4);
  for (const member of visible) {
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    decorateAvatar(avatar, member);
    avatar.title = member.name;
    els.avatarStack.append(avatar);
  }
  if (members.length > 4) {
    const more = document.createElement('span');
    more.className = 'avatar avatar-more';
    more.textContent = `+${members.length - 4}`;
    els.avatarStack.append(more);
  }
}

function renderMemberList(container, members) {
  if (!container) return;
  container.replaceChildren();
  for (const member of members) {
    const item = document.createElement('li');
    item.className = 'member';

    const avatar = document.createElement('span');
    avatar.className = 'member-avatar';
    decorateAvatar(avatar, member);
    item.append(avatar);

    const info = document.createElement('div');
    info.className = 'member-info';
    const name = document.createElement('span');
    name.className = 'member-name';
    const nameText = document.createElement('span');
    nameText.textContent = member.name;
    name.append(nameText);
    if (member.role === 'host') name.append(iconUse('i-crown'));
    if (member.id === state.selfId) {
      const you = document.createElement('span');
      you.className = 'you-tag';
      you.textContent = 'YOU';
      name.append(you);
    }
    const role = document.createElement('span');
    role.className = 'member-role';
    role.textContent = member.role === 'host' ? '房主' : '观众';
    info.append(name, role);
    item.append(info);
    container.append(item);
  }
}

function decorateAvatar(element, member) {
  const key = `${member.id || ''}${member.name || ''}`;
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  const [from, to] = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  element.style.background = `linear-gradient(145deg, ${from}, ${to})`;
  const characters = Array.from(member.name || '?');
  element.textContent =
    characters.length <= 2
      ? characters.join('')
      : characters.slice(0, 1).join('').toUpperCase();
}

function iconUse(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon icon-small');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function refreshStatus() {
  if (!els.roomStatus) return;

  let text = '正在连接';
  let tone = 'waiting';
  const playing = isEffectivePlaying();

  if (!state.joined) {
    text = state.roomClosed
      ? '放映结束'
      : state.fatal
        ? '连接已断开'
        : '连接中';
    tone = state.roomClosed || state.fatal ? 'error' : 'waiting';
  } else if (state.role === 'host') {
    if (state.videoError) {
      text = '片源异常';
      tone = 'error';
    } else if (state.hostBuffering) {
      text = '房主缓冲中';
      tone = 'waiting';
    } else if (els.video.paused) {
      text = '房主已暂停';
      tone = 'paused';
    } else {
      text = '房主正在播放';
      tone = 'playing';
    }
  } else if (!state.hostOnline) {
    text = '等待房主';
    tone = 'waiting';
  } else if (state.videoError) {
    text = '片源异常';
    tone = 'error';
  } else if (state.sync?.buffering) {
    text = '房主缓冲中';
    tone = 'waiting';
  } else if (playing) {
    text = state.guestBuffering ? '跟随缓冲中' : '跟随播放中';
    tone = 'playing';
  } else if (state.sync) {
    text = '房主已暂停';
    tone = 'paused';
  }

  els.roomStatus.dataset.tone = tone;
  els.roomStatusText.textContent = text;

  const hostOnline = state.role === 'host' ? true : state.hostOnline;
  els.hostPresence.dataset.online = String(hostOnline);
  const hostText = els.hostPresence.querySelector('span');
  if (hostText) {
    hostText.textContent =
      state.role === 'host' ? '你是房主' : hostOnline ? '房主在线' : '等待房主';
  }
  updateSyncIndicator();
}

function updateSyncIndicator() {
  if (!els.syncIndicator) return;
  let label = '等待同步';
  let mode = 'waiting';

  if (!state.joined) {
    label = state.roomClosed ? '已结束' : '离线';
    mode = 'offline';
  } else if (state.role === 'host') {
    label = '房主控制';
    mode = 'synced';
  } else if (!state.hostOnline) {
    label = '等待房主';
    mode = 'waiting';
  } else if (!state.sync) {
    label = '等待同步';
    mode = 'waiting';
  } else if (!state.sourceReady) {
    label = '加载中';
    mode = 'waiting';
  } else if (state.guestBuffering) {
    label = '缓冲中';
    mode = 'waiting';
  } else if (!isEffectivePlaying()) {
    label = '已暂停';
    mode = 'waiting';
  } else if (els.video.paused) {
    label = '待播放';
    mode = 'waiting';
  } else {
    const drift = Math.abs(els.video.currentTime - targetPosition());
    if (drift > 1.25) {
      label = '校正中';
      mode = 'waiting';
    } else {
      label = '已同步';
      mode = 'synced';
    }
  }

  els.syncIndicator.dataset.state = mode;
  els.syncText.textContent = label;
}

function refreshControls() {
  const canControl =
    state.role === 'host' &&
    state.joined &&
    state.sourceReady &&
    !state.videoError;
  els.playToggle.disabled = !canControl;
  els.seekRange.disabled = !canControl || getDuration() <= 0;
  els.speedButton.disabled = !state.sourceReady || state.role !== 'host';
  els.playToggle.classList.toggle('is-playing', !els.video.paused);
  els.playToggle.setAttribute(
    'aria-label',
    els.video.paused ? '播放' : '暂停',
  );
  els.playToggle.title =
    state.role === 'guest' ? '只有房主可以控制播放' : canControl ? '' : '片源加载后可播放';
  els.seekRange.title =
    state.role === 'guest' ? '只有房主可以拖动进度' : '';
  els.roleBadge.textContent = state.role === 'host' ? '房主' : '访客';
  els.roleBadge.dataset.role = state.role || 'guest';
  els.sideRole.textContent = state.role === 'host' ? '房主' : '访客';
  refreshSpeedLabel();
  updateVolumeUi();
  updateSubtitleButton();
}

function refreshSpeedLabel() {
  const rate =
    state.role === 'host'
      ? els.video.playbackRate || 1
      : Number(state.sync?.rate) || 1;
  els.speedButton.textContent = `${formatRate(rate)}×`;
}

function formatRate(rate) {
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(2).replace(/0$/, '');
}

function getDuration() {
  if (Number.isFinite(els.video.duration) && els.video.duration > 0) {
    return els.video.duration;
  }
  if (Number.isFinite(state.sync?.duration) && state.sync.duration > 0) {
    return state.sync.duration;
  }
  return 0;
}

function isEffectivePlaying() {
  return Boolean(state.sync?.playing && !state.sync?.buffering);
}

function targetPosition() {
  if (!state.sync) return 0;
  let position = state.sync.position;
  if (isEffectivePlaying()) {
    let elapsed;
    if (state.clockSynced) {
      elapsed = (Date.now() + state.clockOffset - state.sync.serverTime) / 1_000;
    } else {
      elapsed = (performance.now() - state.sync.receivedPerf) / 1_000;
    }
    position += Math.max(0, elapsed) * state.sync.rate;
  }
  const duration = getDuration();
  if (duration > 0) position = Math.min(position, duration);
  return Math.max(0, position);
}

function effectiveSourceUrl() {
  if (state.compat.active && state.compat.url) return state.compat.url;
  return state.room?.videoUrl || '';
}

function setupSource(overrideUrl) {
  if (!state.room) return;
  const url = overrideUrl || effectiveSourceUrl();
  if (!url) return;
  if (state.sourceLoaded && state.sourceUrl === url) return;

  destroyHls();
  state.subtitle.native = [];
  state.subtitle.hls = [];
  if (state.subtitle.mode === 'native' || state.subtitle.mode === 'hls') {
    state.subtitle.mode = 'off';
    state.subtitle.active = null;
    updateSubtitleButton();
  }
  clearSubtitleOverlay();
  if (state.subtitle.panelOpen) renderSubtitleList();
  state.sourceLoaded = true;
  state.sourceReady = false;
  state.videoError = false;
  state.sourceUrl = url;
  state.hostBuffering = false;
  state.guestBuffering = false;
  state.pendingHostSeek = null;

  const video = els.video;
  video.pause();
  video.removeAttribute('src');
  video.load();

  els.playerError.hidden = true;
  els.playerCurtain.hidden = true;
  els.playerSpinner.hidden = false;
  els.spinnerText.textContent = '正在加载片源…';

  const isHls = isHlsUrl(url);
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
  if (isHls && !nativeHls) {
    setupHls(url);
    return;
  }

  video.src = url;
  video.load();
}

function isHlsUrl(raw) {
  try {
    return new URL(raw).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return /\.m3u8(?:$|[?#])/i.test(raw);
  }
}

let hlsLibraryPromise = null;

function loadHlsLibrary() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLibraryPromise) return hlsLibraryPromise;
  hlsLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.min.js';
    script.async = true;
    script.onload = () => {
      if (window.Hls) resolve(window.Hls);
      else reject(new Error('HLS 播放器初始化失败'));
    };
    script.onerror = () => {
      hlsLibraryPromise = null;
      reject(new Error('无法加载 HLS 播放器'));
    };
    document.head.append(script);
  });
  return hlsLibraryPromise;
}

async function setupHls(url) {
  try {
    const Hls = await loadHlsLibrary();
    if (state.sourceUrl !== url) return;
    if (!Hls.isSupported()) {
      showVideoError('当前浏览器不支持 HLS 播放，请换用 Chrome、Edge 或 Safari。');
      return;
    }
    const hls = new Hls({
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: 60,
    });
    state.hls = hls;
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, syncHlsSubtitleTracks);
    hls.on(Hls.Events.MANIFEST_PARSED, syncHlsSubtitleTracks);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) return;
      const message = state.compat.active
        ? data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? '兼容模式的 HLS 清单或分片加载失败，服务器可能未完成封装。'
          : '当前设备无法解码兼容模式输出的视频编码。'
        : data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? 'HLS 清单或分片加载失败。请确认直链允许跨域访问，且没有过期。'
          : '这个 HLS 流无法被当前浏览器解码。';
      destroyHls();
      showVideoError(message);
    });
    hls.loadSource(url);
    hls.attachMedia(els.video);
  } catch (error) {
    showVideoError(error.message || '无法加载 HLS 播放器。');
  }
}

function destroyHls() {
  const wasHlsSubtitle = state.subtitle.mode === 'hls';
  if (state.hls) {
    try {
      state.hls.destroy();
    } catch {
      // 忽略销毁异常。
    }
    state.hls = null;
  }
  state.subtitle.hls = [];
  if (wasHlsSubtitle) {
    state.subtitle.mode = 'off';
    state.subtitle.active = null;
    clearSubtitleOverlay();
    updateSubtitleButton();
  }
}

function onLoadedMetadata() {
  state.sourceReady = true;
  state.videoError = false;
  scanNativeTracks();
  updateSubtitleOverlayBounds();
  showPlayerControls();
  refreshTimeline();
  refreshControls();

  if (state.role === 'host') {
    applyHostBaseline();
    sendHostState('ready');
  } else if (state.role === 'guest') {
    synchronizeGuest({ force: true });
  }
}

function onCanPlay() {
  hideSpinner();
  updateSubtitleOverlayBounds();
  showPlayerControls();
  if (state.role === 'host') {
    if (!state.fatal && !state.roomClosed) hideCurtain();
  } else if (state.role === 'guest') {
    synchronizeGuest();
  }
  refreshControls();
}

function onVideoPlay() {
  showPlayerControls();
  refreshControls();
  if (state.role === 'host' && state.joined && !state.applyingRemote) {
    state.hostBuffering = false;
    sendHostState('play');
  }
  if (state.role === 'guest') hideSpinner();
  refreshStatus();
}

function onVideoPlaying() {
  const wasBuffering = state.hostBuffering || state.guestBuffering;
  state.hostBuffering = false;
  state.guestBuffering = false;
  hideSpinner();
  if (
    state.role === 'host' &&
    state.joined &&
    wasBuffering &&
    !state.applyingRemote
  ) {
    sendHostState('play');
  }
  if (state.role === 'guest' && !state.fatal && !state.roomClosed) {
    hideCurtain();
  }
  updateSubtitleOverlay();
  scheduleControlsHide();
  refreshControls();
  refreshStatus();
}

function onVideoPause() {
  showPlayerControls();
  refreshControls();
  if (state.role === 'host' && state.joined && !state.applyingRemote) {
    state.hostBuffering = false;
    sendHostState('pause');
  }
  refreshStatus();
}

function onVideoWaiting() {
  if (!state.joined || !state.sourceReady) return;
  showPlayerControls();
  if (state.role === 'host' && !els.video.paused) {
    if (!state.hostBuffering) {
      state.hostBuffering = true;
      sendHostState('buffer');
    }
  } else if (state.role === 'guest') {
    state.guestBuffering = true;
  }
  refreshStatus();
  updateSyncIndicator();
}

function onVideoSeeked() {
  showPlayerControls();
  refreshTimeline();
  updateSubtitleOverlay();
  if (state.role === 'host' && state.joined && !state.applyingRemote) {
    sendHostState('seek');
  }
}

function onVideoRateChange() {
  refreshSpeedLabel();
  if (state.role === 'host' && state.joined && !state.applyingRemote) {
    sendHostState('rate');
  }
}

function onVideoEnded() {
  showPlayerControls();
  refreshControls();
  refreshStatus();
  if (state.role === 'host' && state.joined) sendHostState('ended');
}

function onVideoError() {
  if (!state.sourceLoaded) return;
  const mediaError = els.video.error;
  let message =
    '请检查直链是否仍可访问且未过期；HLS 片源还需要允许跨域请求（CORS）。';
  if (state.compat.active) {
    message =
      '兼容模式加载失败。可能是片源无法访问，或当前设备仍不支持该视频编码（例如 HEVC 10-bit）。';
  } else if (mediaError?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    message = isMatroskaUrl(state.sourceUrl)
      ? '浏览器无法解码这个 MKV。iPad/Safari 不支持 MKV 容器；可以点击「兼容播放」由服务器重新封装为 HLS。'
      : '浏览器无法解码这个格式，或直链已失效。建议使用 MP4（H.264）或 HLS。';
  } else if (mediaError?.code === MediaError.MEDIA_ERR_NETWORK) {
    message = '下载片源时网络中断，请检查链接和网络。';
  } else if (window.location.protocol === 'https:' && /^http:\/\//i.test(state.sourceUrl)) {
    message = 'HTTPS 页面不能加载 HTTP 片源，请给视频地址配置 HTTPS。';
  }
  if (
    !state.compat.active &&
    isMatroskaUrl(state.room?.videoUrl || '') &&
    mediaError?.code !== MediaError.MEDIA_ERR_NETWORK
  ) {
    message =
      '浏览器无法播放这个 MKV。iPad/Safari 不支持 MKV 容器；可以点击「兼容播放」由服务器重新封装为 HLS。';
  }
  showVideoError(message);
}

function showVideoError(message) {
  if (state.subtitle.panelOpen) setSubtitlePanel(false);
  showPlayerControls();
  clearSubtitleOverlay();
  state.sourceReady = false;
  state.videoError = true;
  hideSpinner();
  els.playerError.hidden = false;
  els.playerErrorText.textContent = message;
  const canCompat =
    state.compat.active || isMatroskaUrl(state.room?.videoUrl || '');
  els.compatSource.hidden = !canCompat;
  els.compatSource.textContent = state.compat.active ? '重试兼容播放' : '兼容播放';
  els.playerCurtain.hidden = true;
  refreshControls();
  refreshStatus();
}

async function startCompatibilityMode() {
  if (!state.roomId || !state.room) return;
  const url = `${window.location.origin}/api/rooms/${encodeURIComponent(state.roomId)}/compat/index.m3u8`;
  state.compat.active = true;
  state.compat.url = url;
  els.playerError.hidden = true;
  els.playerSpinner.hidden = false;
  els.spinnerText.textContent = '正在准备兼容模式，首次可能需要几十秒…';
  showPlayerControls();
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      let message = `兼容模式启动失败（HTTP ${response.status}）`;
      try {
        const body = await response.json();
        message = body?.error?.message || message;
      } catch {
        // 保留默认提示。
      }
      throw new Error(message);
    }
    const playlist = await response.text();
    if (!playlist.includes('#EXTM3U')) {
      throw new Error('兼容模式返回了无效的播放清单。');
    }
    setupSource(url);
  } catch (error) {
    showVideoError(error.message || '兼容模式启动失败。');
  }
}

function hideSpinner() {
  els.playerSpinner.hidden = true;
}

function retrySource() {
  if (!state.room) return;
  destroyHls();
  state.sourceLoaded = false;
  state.sourceUrl = '';
  state.sourceReady = false;
  state.videoError = false;
  els.playerError.hidden = true;
  els.playerSpinner.hidden = false;
  els.spinnerText.textContent = '正在重新加载片源…';
  setupSource();
}

function hideCurtain() {
  els.playerCurtain.hidden = true;
  state.curtainAction = null;
}

function showCurtain(kicker, title, text, action) {
  if (state.videoError && !state.roomClosed) return;
  els.curtainKicker.textContent = kicker;
  els.curtainTitle.textContent = title;
  els.curtainText.textContent = text;
  els.playerCurtain.hidden = false;
  state.curtainAction = action;
  if (action === 'activate') {
    els.curtainButton.hidden = false;
    els.curtainButton.querySelector('span').textContent = '同步播放';
  } else if (action === 'retry') {
    els.curtainButton.hidden = false;
    els.curtainButton.querySelector('span').textContent = '重新加载';
  } else {
    els.curtainButton.hidden = true;
  }
}

function showGuestPrompt() {
  showCurtain(
    state.hostOnline ? 'THE HOST IS PLAYING' : 'WAITING FOR HOST',
    state.hostOnline ? '房主正在播放' : '等待房主回来',
    state.hostOnline
      ? '点击同步，从房主当前进度开始播放。'
      : '房主回来后，你可以同步加入。',
    state.hostOnline ? 'activate' : null,
  );
}

async function onCurtainAction() {
  if (state.curtainAction === 'retry') {
    retrySource();
    return;
  }
  if (state.curtainAction === 'activate') {
    state.guestActive = true;
    state.playBlocked = false;
    await synchronizeGuest({ force: true });
  }
}

function setRemote(callback) {
  state.applyingRemote = true;
  if (state.remoteTimer) window.clearTimeout(state.remoteTimer);
  try {
    callback();
  } finally {
    state.remoteTimer = window.setTimeout(() => {
      state.applyingRemote = false;
    }, 250);
  }
}

function applyHostBaseline() {
  if (state.role !== 'host' || !state.sourceReady || !state.sync) return;
  const target = clamp(
    Number.isFinite(state.pendingHostSeek)
      ? state.pendingHostSeek
      : state.sync.position,
    0,
    getDuration() || Number.MAX_SAFE_INTEGER,
  );
  setRemote(() => {
    if (Math.abs(els.video.currentTime - target) > 0.35) {
      els.video.currentTime = target;
    }
    if (Math.abs(els.video.playbackRate - state.sync.rate) > 0.01) {
      els.video.playbackRate = state.sync.rate;
    }
  });
  state.pendingHostSeek = null;
  refreshTimeline();
  refreshControls();
  if (!state.fatal && !state.roomClosed) hideCurtain();
}

async function synchronizeGuest({ force = false } = {}) {
  if (
    state.role !== 'guest' ||
    !state.joined ||
    !state.sourceReady ||
    !state.sync ||
    state.fatal ||
    state.roomClosed ||
    state.videoError
  ) {
    return;
  }

  const video = els.video;
  const target = targetPosition();
  const effective = isEffectivePlaying();
  const duration = getDuration();

  if (!effective) {
    state.playBlocked = false;
    if (!video.paused) setRemote(() => video.pause());
    const pausedTarget = duration > 0 ? Math.min(target, duration) : target;
    if (
      (force || Math.abs(video.currentTime - pausedTarget) > 0.35) &&
      !video.seeking
    ) {
      setRemote(() => {
        video.currentTime = pausedTarget;
      });
    }
    if (!state.fatal && !state.roomClosed && !state.videoError) hideCurtain();
    updateSyncIndicator();
    return;
  }

  if (!state.guestActive) {
    if (
      (force || Math.abs(video.currentTime - target) > 0.7) &&
      !video.seeking
    ) {
      setRemote(() => {
        video.currentTime = target;
      });
    }
    showGuestPrompt();
    updateSyncIndicator();
    return;
  }

  if (
    (force || Math.abs(video.currentTime - target) > 0.9) &&
    !video.seeking
  ) {
    setRemote(() => {
      video.currentTime = target;
    });
  }
  if (Math.abs(video.playbackRate - state.sync.rate) > 0.01) {
    video.playbackRate = state.sync.rate;
  }

  if (
    duration > 0 &&
    (video.ended || target >= duration - 0.45) &&
    video.currentTime >= duration - 0.75
  ) {
    if (!video.paused) setRemote(() => video.pause());
    updateSyncIndicator();
    return;
  }

  if (video.paused && !state.playBlocked && !state.playAttempt) {
    state.playAttempt = video.play();
    try {
      await state.playAttempt;
      state.playBlocked = false;
      if (!state.fatal) hideCurtain();
    } catch {
      state.playBlocked = true;
      if (!state.fatal && !state.roomClosed) {
        showCurtain(
          'ONE MORE TAP',
          '需要你的点击',
          '浏览器阻止了自动播放，点一下继续同步。',
          'activate',
        );
      }
    } finally {
      state.playAttempt = null;
    }
  }
  updateSyncIndicator();
}

function sendHostState(reason) {
  if (
    state.role !== 'host' ||
    !state.joined ||
    !state.sourceReady ||
    state.videoError
  ) {
    return;
  }
  const duration = getDuration();
  const payload = {
    type: 'host-state',
    state: {
      position: Math.max(0, Number(els.video.currentTime) || 0),
      playing: !els.video.paused && !els.video.ended,
      buffering: state.hostBuffering,
      rate: els.video.playbackRate || 1,
      duration: duration > 0 ? duration : 0,
      reason,
    },
  };
  sendSocket(payload);
}

function togglePlayback() {
  if (
    state.role !== 'host' ||
    !state.joined ||
    !state.sourceReady ||
    state.videoError
  ) {
    return;
  }
  if (els.video.paused) {
    els.video.play().catch(() => {
      toast('浏览器阻止了播放，请再点一次。', 'error');
    });
  } else {
    els.video.pause();
  }
}

function cycleSpeed() {
  if (state.role !== 'host' || !state.sourceReady) return;
  const current = els.video.playbackRate || 1;
  let index = SPEEDS.findIndex((speed) => speed > current + 0.001);
  if (index === -1) index = 0;
  els.video.playbackRate = SPEEDS[index];
  refreshSpeedLabel();
}

function toggleMute() {
  els.video.muted = !els.video.muted;
  if (!els.video.muted && els.video.volume === 0) {
    els.video.volume = 0.5;
    state.volume = 0.5;
    els.volumeRange.value = '50';
    storageSet(VOLUME_KEY, '0.5');
  }
  updateVolumeUi();
}

function updateVolumeUi() {
  const video = els.video;
  const muted = video.muted || video.volume === 0;
  els.muteToggle.classList.toggle('is-muted', muted);
  els.muteToggle.setAttribute('aria-label', muted ? '取消静音' : '静音');
  if (Number(els.volumeRange.value) !== Math.round(video.volume * 100)) {
    els.volumeRange.value = String(Math.round(video.volume * 100));
  }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (els.playerShell.requestFullscreen) {
      await els.playerShell.requestFullscreen();
    } else if (els.video.webkitEnterFullscreen) {
      els.video.webkitEnterFullscreen();
    }
  } catch {
    toast('当前浏览器无法进入全屏。', 'error');
  }
}

function updateFullscreenButton() {
  const active = Boolean(document.fullscreenElement);
  els.fullscreenButton.setAttribute('aria-label', active ? '退出全屏' : '全屏');
}

/* ---------- 字幕菜单与叠加层 ---------- */


function subtitleActiveKey() {
  return state.subtitle.mode === 'off'
    ? 'off'
    : state.subtitle.active?.key || 'off';
}

function scanNativeTracks() {
  if (!els.video?.textTracks) return;
  const tracks = [...els.video.textTracks]
    .filter((track) => track.kind === 'subtitles' || track.kind === 'captions')
    .map((track, index) => {
      const label =
        track.label ||
        track.language ||
        `视频字幕 ${index + 1}`;
      return {
        key: `text:${index}:${track.language || ''}:${label}`,
        label,
        language: track.language || '',
        track,
      };
    });
  state.subtitle.native = tracks;
  if (state.subtitle.panelOpen) renderSubtitleList();
}

function syncHlsSubtitleTracks() {
  const tracks = state.hls?.subtitleTracks || [];
  state.subtitle.hls = tracks.map((track, index) => ({
    key: `hls:${index}:${track.lang || ''}:${track.name || ''}`,
    index,
    label: track.name || track.lang || `流内字幕 ${index + 1}`,
    language: track.lang || '',
    group: track.groupId || '',
  }));
  if (
    state.subtitle.mode === 'hls' &&
    !state.subtitle.hls.some((track) => track.key === state.subtitle.active?.key)
  ) {
    setSubtitleOff({ closePanel: false });
  }
  if (state.subtitle.panelOpen) renderSubtitleList();
}

function updateSubtitleButton() {
  if (!els.subtitleButton) return;
  const active = state.subtitle.mode !== 'off';
  els.subtitleButton.dataset.active = active ? 'true' : 'false';
  els.subtitleButton.setAttribute('aria-pressed', active ? 'true' : 'false');
  els.subtitleButton.title = active
    ? `字幕：${state.subtitle.active?.label || '开启'}`
    : '字幕';
}

function setSubtitlePanel(open) {
  if (open) {
    scanNativeTracks();
    renderSubtitleList();
    els.subtitlePanel.hidden = false;
    state.subtitle.panelOpen = true;
    state.controls.pinned = true;
    els.playerShell.classList.add('subtitle-panel-open');
    els.subtitleButton.setAttribute('aria-expanded', 'true');
    showPlayerControls();
    els.subtitleError.hidden = true;
    if (
      state.subtitle.embedded.status === 'idle' &&
      isMatroskaUrl(state.room?.videoUrl)
    ) {
      loadEmbeddedTracks();
    }
  } else {
    els.subtitlePanel.hidden = true;
    state.subtitle.panelOpen = false;
    state.controls.pinned = false;
    els.playerShell.classList.remove('subtitle-panel-open');
    els.subtitleButton.setAttribute('aria-expanded', 'false');
    showPlayerControls();
  }
}

function appendSubtitleGroup(container, label) {
  const group = document.createElement('div');
  group.className = 'subtitle-group-label';
  group.textContent = label;
  container.append(group);
}

function appendSubtitleOption(container, options) {
  const row = document.createElement('div');
  row.className = 'subtitle-option-row';

  const button = document.createElement('button');
  button.className = 'subtitle-option';
  button.type = 'button';
  button.dataset.active = options.active ? 'true' : 'false';
  button.disabled = Boolean(options.disabled);
  button.title = options.title || options.label;
  button.addEventListener('click', options.onSelect);

  const check = document.createElement('span');
  check.className = 'subtitle-check';
  check.setAttribute('aria-hidden', 'true');
  check.textContent = '✓';

  const copy = document.createElement('span');
  copy.className = 'subtitle-option-copy';
  const label = document.createElement('span');
  label.className = 'subtitle-option-label';
  label.textContent = options.label;
  copy.append(label);
  if (options.meta) {
    const meta = document.createElement('span');
    meta.className = 'subtitle-option-meta';
    meta.textContent = options.meta;
    copy.append(meta);
  }

  button.append(check, copy);
  if (options.format) {
    const format = document.createElement('span');
    format.className = 'subtitle-format';
    format.textContent = options.format;
    button.append(format);
  }
  row.append(button);

  if (options.onRemove) {
    const remove = document.createElement('button');
    remove.className = 'subtitle-remove';
    remove.type = 'button';
    remove.title = '移除这条字幕';
    remove.setAttribute('aria-label', `移除字幕 ${options.label}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onRemove();
    });
    row.append(remove);
  }

  container.append(row);
}

function renderSubtitleList() {
  if (!els.subtitleList) return;
  els.subtitleList.replaceChildren();
  const activeKey = subtitleActiveKey();

  appendSubtitleOption(els.subtitleList, {
    key: 'off',
    label: '关闭字幕',
    meta: '不显示任何字幕',
    active: state.subtitle.mode === 'off',
    onSelect: () => {
      setSubtitleOff();
    },
  });

  const hlsTracks = state.subtitle.hls || [];
  const nativeTracks = state.subtitle.native || [];
  const streamTracks = hlsTracks.length ? hlsTracks : nativeTracks;

  if (streamTracks.length) {
    appendSubtitleGroup(
      els.subtitleList,
      hlsTracks.length ? '流内字幕轨道' : '视频字幕轨道',
    );
    for (const track of streamTracks) {
      const language = track.language ? `语言 ${track.language}` : '内嵌轨道';
      appendSubtitleOption(els.subtitleList, {
        label: track.label,
        meta: hlsTracks.length ? `${language} · 随片源提供` : language,
        active: activeKey === track.key,
        onSelect: () => {
          if (hlsTracks.length) activateHlsSubtitle(track);
          else activateNativeSubtitle(track);
        },
      });
    }
  }

  renderEmbeddedSubtitleOptions();

  if (state.subtitle.external.length) {
    appendSubtitleGroup(els.subtitleList, '已添加字幕');
    for (const track of state.subtitle.external) {
      appendSubtitleOption(els.subtitleList, {
        label: track.label,
        meta: `${track.format.toUpperCase()} · ${track.host}`,
        format: track.format,
        title: track.url,
        active: activeKey === `external:${track.id}`,
        onSelect: () => activateExternalSubtitle(track),
        onRemove: () => removeExternalSubtitle(track),
      });
    }
  } else {
    const empty = document.createElement('p');
    empty.className = 'subtitle-empty';
    empty.textContent = '还没有外部字幕，粘贴一个 ASS / VTT / SRT 地址试试。';
    els.subtitleList.append(empty);
  }

  updateSubtitleButton();
}


function isMatroskaUrl(rawUrl) {
  try {
    return /\.(mkv|mk3d|mka)$/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

function renderEmbeddedSubtitleOptions() {
  const embedded = state.subtitle.embedded;
  appendSubtitleGroup(els.subtitleList, '影片内封字幕');

  if (embedded.status === 'idle') {
    appendSubtitleOption(els.subtitleList, {
      label: '扫描内封字幕',
      meta: '由服务器读取影片内的文字字幕轨',
      onSelect: () => loadEmbeddedTracks(),
    });
    return;
  }

  if (embedded.status === 'loading') {
    const loading = document.createElement('p');
    loading.className = 'subtitle-empty';
    loading.textContent = '正在扫描影片内封字幕，可能需要几秒…';
    els.subtitleList.append(loading);
    return;
  }

  if (embedded.status === 'error') {
    const error = document.createElement('p');
    error.className = 'subtitle-empty subtitle-empty-error';
    error.textContent = embedded.error || '内封字幕读取失败。';
    els.subtitleList.append(error);
    appendSubtitleOption(els.subtitleList, {
      label: '重新扫描内封字幕',
      meta: '再次请求服务器读取字幕轨',
      onSelect: () => {
        state.subtitle.embedded.status = 'idle';
        loadEmbeddedTracks();
      },
    });
    return;
  }

  if (embedded.tracks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'subtitle-empty';
    empty.textContent = '没有发现内封字幕轨。';
    els.subtitleList.append(empty);
    return;
  }

  for (const track of embedded.tracks) {
    const loading = embedded.loadingId === track.id;
    const metaParts = ['内封', track.codec?.toUpperCase()].filter(Boolean);
    if (track.languageLabel) metaParts.push(track.languageLabel);
    if (track.default) metaParts.push('默认');
    appendSubtitleOption(els.subtitleList, {
      label: loading ? `${track.label} · 提取中…` : track.label,
      meta: metaParts.join(' · '),
      format: 'ass',
      active: false,
      disabled: !track.supported || (embedded.loadingId !== null && !loading),
      title: track.supported ? '从影片内封轨道提取' : '图形字幕暂不支持',
      onSelect: () => loadEmbeddedSubtitle(track),
    });
  }
}

async function loadEmbeddedTracks() {
  if (!state.roomId || state.subtitle.embedded.status === 'loading') return;
  const embedded = state.subtitle.embedded;
  embedded.status = 'loading';
  embedded.error = '';
  if (state.subtitle.panelOpen) renderSubtitleList();

  try {
    const data = await api(
      `/api/rooms/${encodeURIComponent(state.roomId)}/embedded-subtitles`,
    );
    embedded.tracks = Array.isArray(data.tracks) ? data.tracks : [];
    embedded.status = 'ready';
  } catch (error) {
    embedded.status = 'error';
    embedded.error =
      error.code === 'FFMPEG_UNAVAILABLE'
        ? '服务器未安装 FFmpeg，无法读取内封字幕。'
        : error.message || '内封字幕读取失败。';
  }
  if (state.subtitle.panelOpen) renderSubtitleList();
}

async function loadEmbeddedSubtitle(track) {
  if (state.subtitle.embedded.loadingId !== null) return;
  const embedded = state.subtitle.embedded;
  const existing = state.subtitle.external.find(
    (item) => item.embeddedKey === `${state.roomId}:${track.id}`,
  );
  if (existing) {
    activateExternalSubtitle(existing);
    return;
  }

  embedded.loadingId = track.id;
  if (state.subtitle.panelOpen) renderSubtitleList();
  toast(`正在提取内封字幕：${track.label}…`);

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 130_000);
  try {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(state.roomId)}/embedded-subtitles/${track.id}`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      let message = `内封字幕提取失败（HTTP ${response.status}）`;
      try {
        const body = await response.json();
        message = body?.error?.message || message;
        if (body?.error?.code === 'FFMPEG_UNAVAILABLE') {
          message = '服务器未安装 FFmpeg，无法读取内封字幕。';
        }
      } catch {
        // 保留默认错误。
      }
      throw new Error(message);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 24 * 1_024 * 1_024) {
      throw new Error('内封字幕文件过大，暂不支持。');
    }
    const parsed = parseSubtitleText(decodeSubtitleBuffer(buffer), {
      url: response.url,
    });
    const subtitleTrack = {
      id: `sub-${++state.subtitle.idCounter}`,
      label: `内封 · ${track.label}`,
      host: '影片内封',
      url: response.url,
      format: parsed.format,
      cues: parsed.cues,
      ass: parsed.ass,
      embeddedKey: `${state.roomId}:${track.id}`,
    };
    state.subtitle.external.push(subtitleTrack);
    activateExternalSubtitle(subtitleTrack);
    toast(`已加载内封字幕：${track.label}`);
  } catch (error) {
    const message =
      error.name === 'AbortError'
        ? '内封字幕提取超时，尤其常见于较大的 MKV 文件。'
        : error.message || '内封字幕提取失败。';
    toast(message, 'error');
  } finally {
    window.clearTimeout(timer);
    embedded.loadingId = null;
    if (state.subtitle.panelOpen) renderSubtitleList();
  }
}

function disableNativeAndHls() {
  for (const track of els.video.textTracks || []) {
    track.mode = 'disabled';
  }
  if (state.hls) {
    state.hls.subtitleTrack = -1;
    state.hls.subtitleDisplay = false;
  }
}

function clearSubtitleOverlay() {
  if (!els.subtitleOverlay) return;
  els.subtitleOverlay.replaceChildren();
  els.subtitleOverlay.hidden = true;
  state.subtitle.signature = '';
}

function setSubtitleOff({ closePanel = true } = {}) {
  disableNativeAndHls();
  state.subtitle.mode = 'off';
  state.subtitle.active = null;
  clearSubtitleOverlay();
  updateSubtitleButton();
  if (state.subtitle.panelOpen) renderSubtitleList();
  if (closePanel) setSubtitlePanel(false);
}

function activateExternalSubtitle(track) {
  disableNativeAndHls();
  state.subtitle.mode = 'external';
  state.subtitle.active = {
    source: 'external',
    key: `external:${track.id}`,
    label: track.label,
    track,
  };
  clearSubtitleOverlay();
  updateSubtitleOverlayBounds();
  updateSubtitleOverlay();
  updateSubtitleButton();
  setSubtitlePanel(false);
  toast(`已启用字幕：${track.label}`);
}

function activateNativeSubtitle(track) {
  if (state.hls) {
    state.hls.subtitleTrack = -1;
    state.hls.subtitleDisplay = false;
  }
  for (const textTrack of els.video.textTracks || []) {
    textTrack.mode = textTrack === track.track ? 'showing' : 'disabled';
  }
  state.subtitle.mode = 'native';
  state.subtitle.active = {
    source: 'native',
    key: track.key,
    label: track.label,
  };
  clearSubtitleOverlay();
  updateSubtitleButton();
  setSubtitlePanel(false);
  toast(`已启用内嵌字幕：${track.label}`);
}

function activateHlsSubtitle(track) {
  for (const textTrack of els.video.textTracks || []) {
    textTrack.mode = 'disabled';
  }
  if (!state.hls) return;
  state.hls.subtitleDisplay = true;
  state.hls.subtitleTrack = track.index;
  state.subtitle.mode = 'hls';
  state.subtitle.active = {
    source: 'hls',
    key: track.key,
    label: track.label,
  };
  clearSubtitleOverlay();
  updateSubtitleButton();
  setSubtitlePanel(false);
  toast(`已启用流内字幕：${track.label}`);
}

function removeExternalSubtitle(track) {
  const isActive =
    state.subtitle.mode === 'external' &&
    state.subtitle.active?.track?.id === track.id;
  state.subtitle.external = state.subtitle.external.filter(
    (item) => item.id !== track.id,
  );
  if (isActive) {
    setSubtitleOff({ closePanel: false });
  }
  renderSubtitleList();
  toast('已移除字幕');
}

function subtitleFileName(url) {
  try {
    const parsed = new URL(url);
    let name = parsed.pathname.split('/').filter(Boolean).pop() || '';
    try {
      name = decodeURIComponent(name);
    } catch {
      // 保留未解码文件名。
    }
    name = name.replace(/\.(ass|ssa|vtt|srt|webvtt)$/i, '');
    return Array.from(name || parsed.hostname).slice(0, 34).join('');
  } catch {
    return '外部字幕';
  }
}

async function onAddSubtitle(event) {
  event.preventDefault();
  if (state.subtitle.loading) return;

  let url;
  try {
    url = new URL(els.subtitleUrl.value.trim(), window.location.href);
  } catch {
    showSubtitleError('请输入有效的字幕 URL。');
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    showSubtitleError('字幕 URL 需要使用 http:// 或 https://。');
    return;
  }

  const duplicate = state.subtitle.external.find(
    (track) => track.url === url.href,
  );
  if (duplicate) {
    activateExternalSubtitle(duplicate);
    return;
  }

  state.subtitle.loading = true;
  els.subtitleError.hidden = true;
  setButtonBusy(els.subtitleAdd, true, '加载中…', '添加');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(`下载字幕失败（HTTP ${response.status}）`);
    }
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > 8 * 1_024 * 1_024) {
      throw new Error('字幕文件超过 8 MB，暂不支持');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 8 * 1_024 * 1_024) {
      throw new Error('字幕文件超过 8 MB，暂不支持');
    }
    const text = decodeSubtitleBuffer(buffer);
    const parsed = parseSubtitleText(text, { url: url.href });
    const track = {
      id: `sub-${++state.subtitle.idCounter}`,
      label: subtitleFileName(url.href),
      host: url.hostname,
      url: url.href,
      format: parsed.format,
      cues: parsed.cues,
      ass: parsed.ass,
    };
    state.subtitle.external.push(track);
    els.subtitleUrl.value = '';
    activateExternalSubtitle(track);
    toast(`已加载 ${parsed.format.toUpperCase()} 字幕`);
  } catch (error) {
    let message = error.message || '字幕加载失败';
    if (error.name === 'AbortError') {
      message = '字幕下载超时，请检查链接或跨域设置。';
    } else if (error instanceof TypeError) {
      message =
        '无法读取字幕文件。请确认链接可访问，并允许跨域请求（CORS）。';
    }
    showSubtitleError(message);
  } finally {
    window.clearTimeout(timeout);
    state.subtitle.loading = false;
    setButtonBusy(els.subtitleAdd, false, '加载中…', '添加');
  }
}

function showSubtitleError(message) {
  els.subtitleError.textContent = message;
  els.subtitleError.hidden = false;
}

function updateSubtitleOverlayBounds() {
  if (!els.playerShell) return;
  const shellWidth = els.playerShell.clientWidth;
  const shellHeight = els.playerShell.clientHeight;
  if (!shellWidth || !shellHeight) return;

  const videoWidth = els.video.videoWidth || 16;
  const videoHeight = els.video.videoHeight || 9;
  const scale = Math.min(shellWidth / videoWidth, shellHeight / videoHeight);
  const width = Math.max(1, Math.round(videoWidth * scale));
  const height = Math.max(1, Math.round(videoHeight * scale));
  const left = Math.round((shellWidth - width) / 2);
  const top = Math.round((shellHeight - height) / 2);

  for (const layer of [els.subtitleOverlay, els.danmakuLayer]) {
    if (!layer) continue;
    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
    layer.style.width = `${width}px`;
    layer.style.height = `${height}px`;
  }
  state.chat.laneFreeAt = [];
  state.subtitle.signature = '';
  updateSubtitleOverlay();
}

function activeSubtitleCues(cues, time) {
  return cues.filter((cue) => cue.start <= time + 0.02 && cue.end > time - 0.02);
}

function updateSubtitleOverlay() {
  if (
    state.subtitle.mode !== 'external' ||
    !state.subtitle.active?.track ||
    !state.sourceReady ||
    !els.subtitleOverlay
  ) {
    return;
  }
  const track = state.subtitle.active.track;
  const time = Number(els.video.currentTime) || 0;
  const cues = activeSubtitleCues(track.cues, time);

  if (cues.length === 0) {
    if (!els.subtitleOverlay.hidden) clearSubtitleOverlay();
    return;
  }

  const signature = `${cues.map((cue) => cue.id).join(',')}:${els.subtitleOverlay.clientWidth}x${els.subtitleOverlay.clientHeight}`;
  if (signature === state.subtitle.signature) return;
  state.subtitle.signature = signature;
  els.subtitleOverlay.hidden = false;
  els.subtitleOverlay.replaceChildren();

  if (track.format === 'ass' && track.ass) {
    for (const cue of cues.slice(0, 24)) {
      els.subtitleOverlay.append(buildAssSubtitleCue(cue, track.ass));
    }
  } else {
    const stack = document.createElement('div');
    stack.className = 'plain-subtitle-stack';
    for (const cue of cues.slice(0, 8)) {
      const element = document.createElement('div');
      element.className = 'plain-cue';
      element.textContent = cue.text;
      stack.append(element);
    }
    els.subtitleOverlay.append(stack);
  }
}

function rgba(color) {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${color.a.toFixed(3)})`;
}

function assTextShadow(style, scale) {
  const shadows = [];
  const outlineWidth = Math.max(0, style.outlineWidth * scale);
  if (outlineWidth > 0 && style.borderStyle !== 3) {
    const width = Math.min(6, Math.max(0.8, outlineWidth));
    const directions = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    for (const [x, y] of directions) {
      shadows.push(`${x * width}px ${y * width}px 0 ${rgba(style.outline)}`);
    }
  }
  if (style.shadow > 0) {
    const distance = Math.max(1, style.shadow * scale);
    shadows.push(
      `${distance}px ${distance}px ${distance * 1.4}px ${rgba(style.back)}`,
    );
  }
  return shadows.join(', ');
}

function applyAssRunStyle(element, style, scale) {
  const fontName = String(style.fontName || 'Arial').replace(/["'\\;{}]/g, '');
  element.style.fontFamily = `"${fontName}", "Noto Sans SC", "Microsoft YaHei", sans-serif`;
  element.style.fontSize = `${Math.max(8, style.fontSize * scale)}px`;
  element.style.fontWeight = style.bold ? '700' : '400';
  element.style.fontStyle = style.italic ? 'italic' : 'normal';
  const decorations = [];
  if (style.underline) decorations.push('underline');
  if (style.strikeOut) decorations.push('line-through');
  element.style.textDecoration = decorations.join(' ');
  element.style.color = rgba(style.primary);
  element.style.letterSpacing = `${style.spacing * scale}px`;
  element.style.textShadow = assTextShadow(style, scale);

  const transforms = [];
  if (style.scaleX && style.scaleX !== 100) {
    transforms.push(`scaleX(${style.scaleX / 100})`);
  }
  if (style.scaleY && style.scaleY !== 100) {
    transforms.push(`scaleY(${style.scaleY / 100})`);
  }
  if (style.angle) transforms.push(`rotate(${style.angle}deg)`);
  if (transforms.length) {
    element.style.display = 'inline-block';
    element.style.transform = transforms.join(' ');
  }
}

function buildAssSubtitleCue(event, ass) {
  const overlay = els.subtitleOverlay;
  const overlayWidth = overlay.clientWidth || 1;
  const overlayHeight = overlay.clientHeight || 1;
  const scale = overlayHeight / (ass.playResY || 1080);
  const alignment = Math.min(9, Math.max(1, event.alignment || 2));
  const horizontal = (alignment - 1) % 3;
  const vertical = Math.floor((alignment - 1) / 3);
  const textAlign = ['left', 'center', 'right'][horizontal];

  const element = document.createElement('div');
  element.className = 'ass-cue';
  element.style.textAlign = textAlign;

  const runs = event.runs.filter((run) => run.text);
  const firstStyle = runs.find((run) => run.text !== '\n')?.style;
  if (firstStyle && firstStyle.borderStyle === 3) {
    element.style.background = rgba(firstStyle.back);
    const padding = Math.max(3, firstStyle.fontSize * scale * 0.16);
    element.style.padding = `${padding * 0.45}px ${padding}px`;
  }

  if (event.position) {
    element.style.left = `${(event.position.x / (ass.playResX || 1920)) * 100}%`;
    element.style.top = `${(event.position.y / (ass.playResY || 1080)) * 100}%`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    const translateX =
      horizontal === 1 ? '-50%' : horizontal === 2 ? '-100%' : '0';
    const translateY =
      vertical === 0 ? '-100%' : vertical === 1 ? '-50%' : '0';
    element.style.transform = `translate(${translateX}, ${translateY})`;
  } else {
    element.style.left = `${(event.marginL / (ass.playResX || 1920)) * 100}%`;
    element.style.right = `${(event.marginR / (ass.playResX || 1920)) * 100}%`;
    if (vertical === 2) {
      element.style.top = `${(event.marginV / (ass.playResY || 1080)) * 100}%`;
    } else if (vertical === 1) {
      element.style.top = '50%';
      element.style.transform = 'translateY(-50%)';
    } else {
      element.style.bottom = `${(event.marginV / (ass.playResY || 1080)) * 100}%`;
    }
  }

  for (const run of runs) {
    if (run.text === '\n') {
      element.append(document.createElement('br'));
      continue;
    }
    const span = document.createElement('span');
    span.className = 'ass-run';
    span.textContent = run.text;
    applyAssRunStyle(span, run.style, scale);
    element.append(span);
  }

  return element;
}


function onKeyDown(event) {
  if (document.getElementById('room-view').hidden) return;
  showPlayerControls();
  if (event.key === 'Escape' && state.subtitle.panelOpen) {
    setSubtitlePanel(false);
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest('input, textarea, select, button, a')
  ) {
    return;
  }

  if (event.code === 'Space') {
    if (state.role === 'host') {
      event.preventDefault();
      togglePlayback();
    } else if (
      state.role === 'guest' &&
      !els.playerCurtain.hidden &&
      state.curtainAction === 'activate'
    ) {
      event.preventDefault();
      onCurtainAction();
    }
    return;
  }

  if (state.role !== 'host' || !state.sourceReady) {
    if (event.key.toLowerCase() === 'm') toggleMute();
    if (event.key.toLowerCase() === 'f') toggleFullscreen();
    return;
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -5 : 5;
    const duration = getDuration();
    els.video.currentTime = clamp(
      els.video.currentTime + delta,
      0,
      duration || Number.MAX_SAFE_INTEGER,
    );
  } else if (event.key.toLowerCase() === 'm') {
    toggleMute();
  } else if (event.key.toLowerCase() === 'f') {
    toggleFullscreen();
  }
}

function onTimeUpdate() {
  updateSubtitleOverlay();
  if (!state.seekingByUser) {
    const position = els.video.currentTime || 0;
    els.currentTime.textContent = formatTime(position);
    const duration = getDuration();
    const fraction = duration > 0 ? clamp(position / duration, 0, 1) : 0;
    els.seekRange.value = String(Math.round(fraction * 1_000));
    setSeekFill(fraction * 100);
  }
  if (state.role === 'guest') {
    updateSyncIndicator();
    refreshStatus();
  }
}

function refreshTimeline() {
  const duration = getDuration();
  if (duration > 0) {
    els.durationTime.textContent = formatTime(duration);
    els.seekRange.disabled =
      state.role !== 'host' ||
      !state.joined ||
      !state.sourceReady ||
      state.videoError;
  } else {
    els.durationTime.textContent = 'LIVE';
    els.seekRange.disabled = true;
  }
  const position = els.video.currentTime || 0;
  els.currentTime.textContent = formatTime(position);
  if (!state.seekingByUser) {
    const fraction = duration > 0 ? clamp(position / duration, 0, 1) : 0;
    els.seekRange.value = String(Math.round(fraction * 1_000));
    setSeekFill(fraction * 100);
  }
}

function setSeekFill(percent) {
  els.seekRange.style.setProperty(
    '--seek-progress',
    `${clamp(percent, 0, 100)}%`,
  );
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${pad(minutes)}:${pad(secs)}`;
}

function formatRoomCode(roomId) {
  if (!roomId) return '——';
  const upper = roomId.toUpperCase();
  return `${upper.slice(0, 4)}-${upper.slice(4)}`;
}

function sourceLabel(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let name = '';
    try {
      name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    } catch {
      name = url.pathname.split('/').filter(Boolean).pop() || '';
    }
    if (name.length > 26) name = `${name.slice(0, 24)}…`;
    return name ? `${url.hostname} · ${name}` : url.hostname;
  } catch {
    return '外部视频直链';
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function setButtonBusy(button, busy, busyText, idleText) {
  button.disabled = busy;
  const label = button.querySelector('span');
  if (label) label.textContent = busy ? busyText : idleText;
}

async function onCreateRoom(event) {
  event.preventDefault();
  const videoUrl = els.videoUrl.value.trim();
  const title = els.roomTitle.value.trim();
  const hostName = els.hostName.value.trim();

  els.createError.hidden = true;
  if (!videoUrl) {
    showCreateError('请先粘贴视频直链。');
    els.videoUrl.focus();
    return;
  }
  let parsed;
  try {
    parsed = new URL(videoUrl);
  } catch {
    showCreateError('视频直链格式不正确。');
    els.videoUrl.focus();
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    showCreateError('视频直链需要使用 http:// 或 https://。');
    els.videoUrl.focus();
    return;
  }

  setButtonBusy(els.createButton, true, '正在创建…', '创建放映厅');
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ videoUrl, title, hostName }),
    });
    state.roomId = data.roomId;
    state.room = data.room;
    state.hostKey = data.hostKey;
    state.name = hostName || data.room.hostName || '房主';
    state.everJoined = false;
    state.sync = null;
    storageSet(hostKeyStorageName(data.roomId), data.hostKey);
    storageSet(NICKNAME_KEY, state.name);
    window.history.pushState({ roomId: data.roomId }, '', `/?room=${data.roomId}`);
    beginConnection();
  } catch (error) {
    showCreateError(error.message || '创建房间失败，请稍后再试。');
  } finally {
    setButtonBusy(els.createButton, false, '正在创建…', '创建放映厅');
  }
}

function showCreateError(message) {
  els.createError.textContent = message;
  els.createError.hidden = false;
}

function onJoinRoom(event) {
  event.preventDefault();
  if (!state.room) return;
  const name = els.joinName.value.trim();
  state.name = name || '访客';
  state.hostKey = null;
  state.guestActive = false;
  state.playBlocked = false;
  state.everJoined = false;
  state.sync = null;
  if (name) storageSet(NICKNAME_KEY, name);
  els.joinError.hidden = true;
  beginConnection();
}

async function leaveRoom() {
  if (
    state.role === 'host' &&
    !window.confirm('你是房主。离开后房间会暂停，其他人会留在这里等待。确定离开吗？')
  ) {
    return;
  }
  state.leaving = true;
  stopTimers();
  clearReconnectTimer();
  try {
    state.ws?.close(1000, 'LEAVE');
  } catch {
    // 忽略。
  }
  pauseVideoForDisconnect();
  window.location.assign('/');
}

function copyInvite() {
  if (!state.roomId) return;
  const url = `${window.location.origin}/r/${state.roomId}`;
  copyText(url).then((ok) => {
    if (!ok) {
      toast('复制失败，请手动复制地址栏中的邀请链接。', 'error');
      return;
    }
    const local = ['localhost', '127.0.0.1', '::1'].includes(
      window.location.hostname,
    );
    toast(
      local
        ? '邀请链接已复制。本机地址只能在本机访问，部署后请换成公网域名。'
        : '邀请链接已复制，发给朋友就能一起看。',
    );
  });
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 尝试兼容复制。
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

function toast(message, tone = 'info') {
  const element = document.createElement('div');
  element.className = 'toast';
  element.dataset.tone = tone;
  element.textContent = message;
  els.toastRegion.append(element);
  window.setTimeout(() => {
    element.classList.add('is-leaving');
    window.setTimeout(() => element.remove(), 220);
  }, 3_400);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
