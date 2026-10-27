import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoom, startTestApp } from './helpers.js';
import { joinRoom, TestSocket } from './ws-client.js';

test('房主控制播放，访客收到同步状态且不能反向控制', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const { payload } = await createRoom(app.baseUrl);
  const host = await joinRoom(app.wsUrl, payload.roomId, {
    hostKey: payload.hostKey,
    name: '小林',
  });
  t.after(() => host.socket.close());
  assert.equal(host.welcome.role, 'host');
  assert.equal(host.welcome.room.videoUrl, 'https://cdn.example.com/movie.mp4');
  assert.equal(host.welcome.room.hostOnline, true);

  const guest = await joinRoom(app.wsUrl, payload.roomId, { name: '阿青' });
  t.after(() => guest.socket.close());
  assert.equal(guest.welcome.role, 'guest');
  assert.equal(guest.welcome.members.length, 2);

  host.socket.send({
    type: 'host-state',
    state: {
      position: 12,
      playing: true,
      buffering: false,
      rate: 1,
      duration: 300,
      reason: 'play',
    },
  });
  const sync = await guest.socket.next(
    (message) => message.type === 'sync' && message.reason === 'play',
  );
  assert.equal(sync.playback.playing, true);
  assert.equal(sync.playback.duration, 300);
  assert.ok(sync.playback.position >= 12 && sync.playback.position < 13);

  guest.socket.send({
    type: 'host-state',
    state: { position: 250, playing: true, reason: 'play' },
  });
  const denied = await guest.socket.next('error');
  assert.equal(denied.code, 'HOST_ONLY');

  guest.socket.send({ type: 'request-sync' });
  const requested = await guest.socket.next(
    (message) => message.type === 'sync' && message.reason === 'request',
  );
  assert.equal(requested.playback.position < 20, true);

  await host.socket.close();
  const paused = await guest.socket.next(
    (message) => message.type === 'sync' && message.reason === 'host-left',
  );
  assert.equal(paused.playback.playing, false);
  assert.equal(paused.hostOnline, false);
  assert.ok(paused.playback.position >= 12 && paused.playback.position < 20);
});

test('错误的房主凭证会被关闭连接', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl);

  const socket = await new TestSocket(
    `${app.wsUrl}/ws?room=${payload.roomId}`,
  ).open();
  socket.send({ type: 'hello', hostKey: 'not-the-key', name: '假房主' });
  const error = await socket.next('error');
  assert.equal(error.code, 'HOST_KEY_INVALID');
  const closed = await socket.closedPromise;
  assert.equal(closed.code, 4003);
});

test('房间人数上限与未 hello 超时', async (t) => {
  const app = await startTestApp({ maxMembers: 2, hostTimeoutMs: 200 });
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl);

  const host = await joinRoom(app.wsUrl, payload.roomId, {
    hostKey: payload.hostKey,
    name: '房主',
  });
  t.after(() => host.socket.close());
  const guest = await joinRoom(app.wsUrl, payload.roomId, { name: '观众' });
  t.after(() => guest.socket.close());

  const third = await new TestSocket(
    `${app.wsUrl}/ws?room=${payload.roomId}`,
  ).open();
  third.send({ type: 'hello', name: '第三个人' });
  const full = await third.next('error');
  assert.equal(full.code, 'ROOM_FULL');
  assert.equal((await third.closedPromise).code, 4005);

  const silent = await new TestSocket(
    `${app.wsUrl}/ws?room=${payload.roomId}`,
  ).open();
  const timeout = await silent.next('error', 2_000);
  assert.equal(timeout.code, 'HELLO_TIMEOUT');
  await silent.closedPromise;
});

test('不存在的房间无法建立 WebSocket 连接', async () => {
  const app = await startTestApp();
  try {
    await assert.rejects(
      new TestSocket(`${app.wsUrl}/ws?room=abcd2345`).open(),
      /404/,
    );
  } finally {
    await app.close();
  }
});

test('房主关闭房间时访客会被通知并断开', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl);
  const host = await joinRoom(app.wsUrl, payload.roomId, {
    hostKey: payload.hostKey,
    name: '房主',
  });
  t.after(() => host.socket.close());
  const guest = await joinRoom(app.wsUrl, payload.roomId, { name: '观众' });
  t.after(() => guest.socket.close());

  const response = await fetch(`${app.baseUrl}/api/rooms/${payload.roomId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${payload.hostKey}` },
  });
  assert.equal(response.status, 200);

  const closed = await guest.socket.next('room-closed');
  assert.match(closed.reason, /关闭/);
  assert.equal((await guest.socket.closedPromise).code, 4000);
});
