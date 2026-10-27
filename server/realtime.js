import { randomBytes } from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

import { clientIp } from './http.js';
import { createRateLimiter } from './rate-limit.js';
import {
  normalizeChatText,
  normalizeDisplayName,
  normalizeRoomId,
} from './rooms.js';

const MAX_MESSAGE_BYTES = 8 * 1_024;
const CHAT_MIN_INTERVAL_MS = 650;
const CHAT_WINDOW_MS = 30_000;
const CHAT_WINDOW_MAX = 20;

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
}

function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host = req.headers.host || '';
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-host'];
    if (typeof forwarded === 'string' && forwarded) {
      host = forwarded.split(',')[0].trim();
    }
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function closeWithError(ws, code, errorCode, message) {
  send(ws, { type: 'error', code: errorCode, message });
  ws.close(code, errorCode);
}

/**
 * WebSocket 房间中枢。
 *
 * 协议：
 *  客户端 -> 服务端：hello / host-state / request-sync / ping
 *  服务端 -> 客户端：welcome / sync / presence / pong / room-closed / error
 *
 * 房主凭证通过 hello 消息发送，而不是放进 URL，避免出现在代理访问日志里。
 */
export class RoomHub {
  constructor({ store, config, now = Date.now, logger = console }) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.logger = logger;
    this.clients = new Map();
    this.roomClients = new Map();
    this.upgradeLimiter = createRateLimiter({
      limit: config.wsLimitPerMin,
      windowMs: 60 * 1_000,
      now,
    });
    this.wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.wss.on('connection', (ws, req, context) => {
      this.handleConnection(ws, req, context);
    });

    this.syncTimer = setInterval(
      () => this.broadcastTick(),
      config.syncIntervalMs,
    );
    this.cleanupTimer = setInterval(() => this.cleanupRooms(), 30_000);
    this.pingTimer = setInterval(() => this.pingClients(), 30_000);
    for (const timer of [this.syncTimer, this.cleanupTimer, this.pingTimer]) {
      timer.unref?.();
    }
    this.upgradeHandler = null;
  }

  attach(server) {
    this.upgradeHandler = (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    };
    server.on('upgrade', this.upgradeHandler);
  }

  handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!originAllowed(req, this.config)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const limit = this.upgradeLimiter(clientIp(req, this.config));
    if (!limit.allowed) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }

    const roomId = normalizeRoomId(url.searchParams.get('room'));
    if (!roomId) {
      rejectUpgrade(socket, 400, 'Invalid Room');
      return;
    }
    const room = this.store.get(roomId);
    if (!room) {
      rejectUpgrade(socket, 404, 'Room Not Found');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req, {
        roomId,
        ip: clientIp(req, this.config),
      });
    });
  }

  handleConnection(ws, req, context) {
    const client = {
      ws,
      id: null,
      role: null,
      name: null,
      roomId: context.roomId,
      joined: false,
      joinedAt: this.now(),
      isAlive: true,
      messageWindowStart: this.now(),
      messageCount: 0,
      lastChatAt: 0,
      chatWindowStart: this.now(),
      chatCount: 0,
    };
    this.clients.set(ws, client);

    const authTimer = setTimeout(() => {
      if (!client.joined && !ws.__closed) {
        closeWithError(ws, 4008, 'HELLO_TIMEOUT', '加入房间超时');
      }
    }, this.config.hostTimeoutMs);
    authTimer.unref?.();

    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('error', () => {
      // close 事件会统一清理；这里防止未处理的 error 导致进程崩溃。
    });
    ws.on('message', (data, isBinary) => {
      this.handleMessage(client, data, isBinary).catch((error) => {
        this.logger.error?.('[ws] message handler failed', error);
        closeWithError(ws, 1011, 'INTERNAL_ERROR', '服务器处理消息失败');
      });
    });
    ws.on('close', () => {
      ws.__closed = true;
      clearTimeout(authTimer);
      this.handleClose(client);
    });
  }

  async handleMessage(client, data, isBinary) {
    if (isBinary) {
      closeWithError(client.ws, 4009, 'PROTOCOL_ERROR', '只接受 JSON 文本消息');
      return;
    }
    if (data.length > MAX_MESSAGE_BYTES) {
      closeWithError(client.ws, 4009, 'MESSAGE_TOO_LARGE', '消息过大');
      return;
    }

    const now = this.now();
    if (now - client.messageWindowStart > 10_000) {
      client.messageWindowStart = now;
      client.messageCount = 0;
    }
    client.messageCount += 1;
    if (client.messageCount > 120) {
      closeWithError(client.ws, 4009, 'TOO_MANY_MESSAGES', '消息过于频繁');
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      closeWithError(client.ws, 4009, 'INVALID_JSON', '消息格式不正确');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      closeWithError(client.ws, 4009, 'INVALID_MESSAGE', '消息格式不正确');
      return;
    }

    if (!client.joined) {
      if (message.type !== 'hello') {
        closeWithError(client.ws, 4009, 'HELLO_REQUIRED', '请先加入房间');
        return;
      }
      this.handleHello(client, message);
      return;
    }

    switch (message.type) {
      case 'host-state':
        this.handleHostState(client, message);
        break;
      case 'chat':
        this.handleChat(client, message);
        break;
      case 'request-sync': {
        const room = this.store.get(client.roomId);
        if (room) this.sendSync(client, room, 'request');
        break;
      }
      case 'ping':
        send(client.ws, {
          type: 'pong',
          t: message.t,
          serverTime: this.now(),
        });
        break;
      case 'hello':
        break;
      default:
        send(client.ws, {
          type: 'error',
          code: 'UNKNOWN_MESSAGE',
          message: '未知的消息类型',
        });
    }
  }

  handleHello(client, message) {
    const room = this.store.get(client.roomId);
    if (!room) {
      closeWithError(client.ws, 4004, 'ROOM_NOT_FOUND', '房间不存在或已过期');
      return;
    }

    const hostKey = typeof message.hostKey === 'string' ? message.hostKey.trim() : '';
    let role = 'guest';
    if (hostKey) {
      if (!this.store.verifyHost(room, hostKey)) {
        closeWithError(client.ws, 4003, 'HOST_KEY_INVALID', '房主凭证无效');
        return;
      }
      role = 'host';
    }

    if (role === 'guest' && room.connections >= this.config.maxMembers) {
      closeWithError(client.ws, 4005, 'ROOM_FULL', '房间人数已满');
      return;
    }

    client.role = role;
    client.name = normalizeDisplayName(
      message.name,
      role === 'host' ? room.hostName : '访客',
    );
    client.id = randomBytes(4).toString('hex');
    client.joined = true;
    client.joinedAt = this.now();

    this.store.join(room, { host: role === 'host' });
    let clients = this.roomClients.get(room.id);
    if (!clients) {
      clients = new Set();
      this.roomClients.set(room.id, clients);
    }
    clients.add(client);

    send(client.ws, {
      type: 'welcome',
      selfId: client.id,
      role,
      room: this.store.publicRoom(room),
      members: this.members(room),
      chat: this.store.chatHistory(room),
      serverTime: this.now(),
    });
    this.broadcastPresence(room);
    if (role === 'host') {
      this.broadcastSync(room, 'host-joined');
    }
  }

  handleChat(client, message) {
    const now = this.now();
    if (now - client.lastChatAt < CHAT_MIN_INTERVAL_MS) {
      send(client.ws, {
        type: 'error',
        code: 'CHAT_RATE_LIMIT',
        message: '发送太快了，稍等一下再发。',
      });
      return;
    }
    if (now - client.chatWindowStart > CHAT_WINDOW_MS) {
      client.chatWindowStart = now;
      client.chatCount = 0;
    }
    if (client.chatCount >= CHAT_WINDOW_MAX) {
      send(client.ws, {
        type: 'error',
        code: 'CHAT_RATE_LIMIT',
        message: '发言太频繁了，休息一会儿吧。',
      });
      return;
    }

    const room = this.store.get(client.roomId);
    if (!room) return;
    const text = normalizeChatText(message.text);
    if (!text) {
      send(client.ws, {
        type: 'error',
        code: 'CHAT_EMPTY',
        message: '消息不能为空。',
      });
      return;
    }

    const chat = this.store.addChat(room, {
      userId: client.id,
      name: client.name,
      role: client.role,
      text,
      now,
    });
    if (!chat) return;
    client.lastChatAt = now;
    client.chatCount += 1;
    this.broadcastChat(room, chat);
  }

  broadcastChat(room, message) {
    const clients = this.roomClients.get(room.id);
    if (!clients || clients.size === 0) return;
    const payload = JSON.stringify({ type: 'chat', message });
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
    }
  }

  handleHostState(client, message) {
    if (client.role !== 'host') {
      send(client.ws, {
        type: 'error',
        code: 'HOST_ONLY',
        message: '只有房主可以控制播放进度',
      });
      return;
    }
    const room = this.store.get(client.roomId);
    if (!room) return;
    if (!message.state || typeof message.state !== 'object') {
      send(client.ws, {
        type: 'error',
        code: 'INVALID_STATE',
        message: '播放状态格式不正确',
      });
      return;
    }

    const allowedReasons = new Set([
      'play',
      'pause',
      'seek',
      'rate',
      'buffer',
      'ready',
      'heartbeat',
      'ended',
    ]);
    const reason = allowedReasons.has(message.state.reason)
      ? message.state.reason
      : 'host-update';
    this.store.applyHostState(room, message.state);
    this.broadcastSync(room, reason);
  }

  handleClose(client) {
    this.clients.delete(client.ws);
    if (!client.joined) return;

    const room = this.store.get(client.roomId);
    const clients = this.roomClients.get(client.roomId);
    clients?.delete(client);
    if (!room) {
      if (clients && clients.size === 0) this.roomClients.delete(client.roomId);
      return;
    }

    this.store.leave(room, { host: client.role === 'host' });
    const hadHosts = room.hostConnections;
    this.broadcastPresence(room);

    if (client.role === 'host' && hadHosts === 0 && room.connections > 0) {
      this.store.pause(room);
      this.broadcastSync(room, 'host-left');
    }
    if (clients && clients.size === 0) this.roomClients.delete(client.roomId);
  }

  members(room) {
    const clients = this.roomClients.get(room.id);
    if (!clients) return [];
    return [...clients]
      .filter((client) => client.joined)
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'host' ? -1 : 1;
        return a.joinedAt - b.joinedAt;
      })
      .map((client) => ({
        id: client.id,
        name: client.name,
        role: client.role,
        joinedAt: client.joinedAt,
      }));
  }

  sendSync(client, room, reason = 'tick') {
    const publicRoom = this.store.publicRoom(room);
    send(client.ws, {
      type: 'sync',
      roomId: room.id,
      playback: publicRoom.playback,
      hostOnline: publicRoom.hostOnline,
      memberCount: publicRoom.memberCount,
      serverTime: this.now(),
      reason,
    });
  }

  broadcastSync(room, reason = 'tick') {
    const clients = this.roomClients.get(room.id);
    if (!clients || clients.size === 0) return;
    const publicRoom = this.store.publicRoom(room);
    const payload = {
      type: 'sync',
      roomId: room.id,
      playback: publicRoom.playback,
      hostOnline: publicRoom.hostOnline,
      memberCount: publicRoom.memberCount,
      serverTime: this.now(),
      reason,
    };
    const text = JSON.stringify(payload);
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(text);
    }
  }

  broadcastPresence(room) {
    const clients = this.roomClients.get(room.id);
    if (!clients || clients.size === 0) return;
    const publicRoom = this.store.publicRoom(room);
    const payload = {
      type: 'presence',
      roomId: room.id,
      members: this.members(room),
      memberCount: publicRoom.memberCount,
      hostOnline: publicRoom.hostOnline,
      serverTime: this.now(),
    };
    const text = JSON.stringify(payload);
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(text);
    }
  }

  broadcastTick() {
    for (const roomId of this.roomClients.keys()) {
      const room = this.store.get(roomId);
      if (!room) continue;
      this.broadcastSync(room, 'tick');
    }
  }

  pingClients() {
    for (const [ws, client] of this.clients) {
      if (!client.isAlive) {
        ws.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  cleanupRooms() {
    const removed = this.store.cleanup();
    for (const room of removed) {
      this.closeRoom(room.id, '房间已过期');
    }
  }

  closeRoom(roomId, reason = '房间已关闭') {
    const clients = this.roomClients.get(roomId);
    if (!clients) return;
    for (const client of [...clients]) {
      send(client.ws, { type: 'room-closed', reason });
      client.ws.close(4000, 'ROOM_CLOSED');
    }
    this.roomClients.delete(roomId);
  }

  close() {
    clearInterval(this.syncTimer);
    clearInterval(this.cleanupTimer);
    clearInterval(this.pingTimer);
    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, 'SERVER_SHUTDOWN');
      } catch {
        client.ws.terminate();
      }
    }
    this.clients.clear();
    this.roomClients.clear();
    this.wss.close();
  }
}
