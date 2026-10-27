import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const ROOM_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ROOM_ID_LENGTH = 8;
const ROOM_ID_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/;
const MAX_VIDEO_URL_LENGTH = 4_096;
const MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_LENGTH = 200;

export class RoomCapacityError extends Error {
  constructor(message = '房间数量已达上限，请稍后再试') {
    super(message);
    this.name = 'RoomCapacityError';
    this.code = 'ROOM_LIMIT';
  }
}

export function normalizeRoomId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return ROOM_ID_RE.test(id) ? id : null;
}

export function normalizeDisplayName(value, fallback = '访客') {
  if (typeof value !== 'string') return fallback;
  const clean = value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, 24).join('') || fallback;
}

export function normalizeRoomTitle(value, fallback = '未命名放映厅') {
  if (typeof value !== 'string') return fallback;
  const clean = value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, 60).join('') || fallback;
}

/**
 * 仅接受浏览器可以直接加载的 HTTP(S) 直链。
 * 服务器不会请求该地址，因此不存在服务端 SSRF；它只会展示给房间成员。
 */
export function normalizeVideoUrl(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('请填写视频直链');
  }
  const value = raw.trim();
  if (!value) throw new ValidationError('请填写视频直链');
  if (value.length > MAX_VIDEO_URL_LENGTH) {
    throw new ValidationError('视频直链过长');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError('视频直链格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('视频直链只能使用 http:// 或 https://');
  }
  if (url.username || url.password) {
    throw new ValidationError('直链中不能包含用户名或密码，请使用签名链接');
  }
  return url.href;
}

export function normalizeChatText(value) {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, MAX_CHAT_LENGTH).join('');
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
  }
}

function hashHostKey(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundSeconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

function makeRoomId() {
  const bytes = randomBytes(ROOM_ID_LENGTH);
  let id = '';
  for (const byte of bytes) {
    id += ROOM_ID_ALPHABET[byte % ROOM_ID_ALPHABET.length];
  }
  return id;
}

/**
 * 内存房间存储。播放进度用「锚点 + 服务器时间」表达，
 * 因而即使房主浏览器短暂停顿，所有客户端仍能从同一时间轴推算进度。
 */
export class RoomStore {
  constructor({
    roomTtlMs = 12 * 60 * 60 * 1_000,
    emptyRoomTtlMs = 120 * 60 * 1_000,
    maxRooms = 500,
    now = () => Date.now(),
    idFactory = makeRoomId,
  } = {}) {
    this.roomTtlMs = roomTtlMs;
    this.emptyRoomTtlMs = emptyRoomTtlMs;
    this.maxRooms = maxRooms;
    this.now = now;
    this.idFactory = idFactory;
    this.rooms = new Map();
  }

  get size() {
    return this.rooms.size;
  }

  create({ videoUrl, title, hostName, now = this.now() }) {
    if (this.rooms.size >= this.maxRooms) throw new RoomCapacityError();

    let id = this.idFactory();
    let attempts = 0;
    while (this.rooms.has(id)) {
      if (++attempts > 50) throw new RoomCapacityError('无法分配房间号，请稍后再试');
      id = this.idFactory();
    }

    const hostKey = randomBytes(32).toString('base64url');
    const room = {
      id,
      title: normalizeRoomTitle(title),
      videoUrl: normalizeVideoUrl(videoUrl),
      hostName: normalizeDisplayName(hostName, '房主'),
      hostKeyHash: hashHostKey(hostKey),
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now + this.roomTtlMs,
      emptySince: now,
      connections: 0,
      hostConnections: 0,
      duration: 0,
      chat: [],
      chatSeq: 0,
      playback: {
        anchorPosition: 0,
        anchorAt: now,
        playing: false,
        buffering: false,
        rate: 1,
      },
    };
    this.rooms.set(id, room);
    return { room, hostKey };
  }

  get(id) {
    const roomId = normalizeRoomId(id);
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  verifyHost(room, key) {
    if (!room || typeof key !== 'string' || !key) return false;
    const actual = Buffer.from(hashHostKey(key), 'hex');
    const expected = Buffer.from(room.hostKeyHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  join(room, { host = false, now = this.now() } = {}) {
    if (!room) return;
    room.connections += 1;
    if (host) room.hostConnections += 1;
    room.emptySince = null;
    room.lastActivityAt = now;
  }

  leave(room, { host = false, now = this.now() } = {}) {
    if (!room) return;
    room.connections = Math.max(0, room.connections - 1);
    if (host) room.hostConnections = Math.max(0, room.hostConnections - 1);
    if (room.connections === 0) room.emptySince = now;
  }

  positionAt(room, now = this.now()) {
    if (!room) return 0;
    const { playback, duration } = room;
    let position = playback.anchorPosition;
    if (playback.playing && !playback.buffering) {
      position += ((now - playback.anchorAt) / 1_000) * playback.rate;
    }
    position = clamp(position, 0, duration > 0 ? duration : MAX_POSITION_SECONDS);
    return roundSeconds(position);
  }

  /**
   * 接受房主上报的真实播放器状态。服务器以收到消息的时间为新锚点，
   * 不信任客户端传来的服务器时间。
   */
  applyHostState(room, state, now = this.now()) {
    if (!room || !state || typeof state !== 'object') return false;

    const previous = {
      position: this.positionAt(room, now),
      playing: room.playback.playing,
      buffering: room.playback.buffering,
      rate: room.playback.rate,
    };

    if (Number.isFinite(state.duration) && state.duration > 0) {
      room.duration = clamp(state.duration, 0, MAX_POSITION_SECONDS);
    }

    const fallbackPosition = this.positionAt(room, now);
    const rawPosition = Number(state.position);
    const maxPosition = room.duration > 0 ? room.duration : MAX_POSITION_SECONDS;
    const position = clamp(
      Number.isFinite(rawPosition) ? rawPosition : fallbackPosition,
      0,
      maxPosition,
    );
    const rate = Number.isFinite(state.rate) ? clamp(state.rate, 0.25, 4) : 1;

    room.playback = {
      anchorPosition: roundSeconds(position),
      anchorAt: now,
      playing: Boolean(state.playing),
      buffering: Boolean(state.buffering),
      rate,
    };
    room.lastActivityAt = now;

    return (
      previous.playing !== room.playback.playing ||
      previous.buffering !== room.playback.buffering ||
      Math.abs(previous.position - position) > 0.05 ||
      Math.abs(previous.rate - rate) > 0.001
    );
  }

  addChat(room, { userId, name, role, text, now = this.now() }) {
    if (!room) return null;
    const normalized = normalizeChatText(text);
    if (!normalized) return null;
    const message = {
      id: `${room.id}-${++room.chatSeq}`,
      userId,
      name,
      role,
      text: normalized,
      at: now,
    };
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT_MESSAGES) {
      room.chat.splice(0, room.chat.length - MAX_CHAT_MESSAGES);
    }
    room.lastActivityAt = now;
    return message;
  }

  chatHistory(room, limit = 50) {
    if (!room) return [];
    return room.chat.slice(-limit);
  }

  /** 房主全部离开后，把时间轴冻结在当前进度，避免访客继续“空放”。 */
  pause(room, now = this.now()) {
    if (!room) return;
    room.playback.anchorPosition = this.positionAt(room, now);
    room.playback.anchorAt = now;
    room.playback.playing = false;
    room.playback.buffering = false;
    room.lastActivityAt = now;
  }

  publicRoom(room, now = this.now()) {
    return {
      id: room.id,
      title: room.title,
      videoUrl: room.videoUrl,
      hostName: room.hostName,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      memberCount: room.connections,
      hostOnline: room.hostConnections > 0,
      playback: {
        position: this.positionAt(room, now),
        playing: room.playback.playing,
        buffering: room.playback.buffering,
        rate: room.playback.rate,
        duration: room.duration,
      },
    };
  }

  close(id) {
    const roomId = normalizeRoomId(id);
    if (!roomId) return null;
    const room = this.rooms.get(roomId) ?? null;
    if (room) this.rooms.delete(roomId);
    return room;
  }

  cleanup(now = this.now()) {
    const removed = [];
    for (const [id, room] of this.rooms) {
      const expired = now >= room.expiresAt;
      const empty =
        room.connections === 0 &&
        room.emptySince !== null &&
        now - room.emptySince >= this.emptyRoomTtlMs;
      if (expired || empty) {
        this.rooms.delete(id);
        removed.push(room);
      }
    }
    return removed;
  }
}
