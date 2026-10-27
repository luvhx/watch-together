import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoom, startTestApp } from './helpers.js';
import { joinRoom, TestSocket } from './ws-client.js';

test('房间聊天会广播并保留加入前的历史', async (t) => {
  const app = await startTestApp({ maxMembers: 5 });
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl);

  const host = await joinRoom(app.wsUrl, payload.roomId, {
    hostKey: payload.hostKey,
    name: '房主小林',
  });
  t.after(() => host.socket.close());
  const guest = await joinRoom(app.wsUrl, payload.roomId, { name: '观众阿青' });
  t.after(() => guest.socket.close());

  host.socket.send({ type: 'chat', text: '  晚上好，准备开始  ' });
  const hostEcho = await host.socket.next('chat');
  const guestEcho = await guest.socket.next('chat');
  assert.equal(hostEcho.message.text, '晚上好，准备开始');
  assert.equal(hostEcho.message.name, '房主小林');
  assert.equal(hostEcho.message.role, 'host');
  assert.equal(hostEcho.message.userId, host.welcome.selfId);
  assert.equal(guestEcho.message.id, hostEcho.message.id);

  guest.socket.send({ type: 'chat', text: '来了来了' });
  const guestMessage = await host.socket.next('chat');
  assert.equal(guestMessage.message.text, '来了来了');
  assert.equal(guestMessage.message.role, 'guest');

  const late = await joinRoom(app.wsUrl, payload.roomId, { name: '迟到的人' });
  t.after(() => late.socket.close());
  assert.equal(late.welcome.chat.length, 2);
  assert.equal(late.welcome.chat[0].text, '晚上好，准备开始');
  assert.equal(late.welcome.chat[1].text, '来了来了');
});

test('聊天发送频率、空消息和超长消息处理', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl);
  const host = await joinRoom(app.wsUrl, payload.roomId, {
    hostKey: payload.hostKey,
    name: '房主',
  });
  t.after(() => host.socket.close());
  const guest = await joinRoom(app.wsUrl, payload.roomId, { name: '访客' });
  t.after(() => guest.socket.close());

  host.socket.send({ type: 'chat', text: '第一条' });
  await host.socket.next('chat');
  host.socket.send({ type: 'chat', text: '太快了' });
  const limited = await host.socket.next('error');
  assert.equal(limited.code, 'CHAT_RATE_LIMIT');

  guest.socket.send({ type: 'chat', text: '   ' });
  const empty = await guest.socket.next('error');
  assert.equal(empty.code, 'CHAT_EMPTY');

  await new Promise((resolve) => setTimeout(resolve, 700));
  guest.socket.send({ type: 'chat', text: '长'.repeat(240) });
  const longMessage = await guest.socket.next(
    (message) => message.type === 'chat' && message.message.name === '访客',
  );
  assert.equal(Array.from(longMessage.message.text).length, 200);
});

test('聊天历史只保留最近 100 条', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl);
  const host = await joinRoom(app.wsUrl, payload.roomId, {
    hostKey: payload.hostKey,
    name: '房主',
  });
  t.after(() => host.socket.close());

  const room = app.store.get(payload.roomId);
  for (let index = 0; index < 105; index += 1) {
    app.store.addChat(room, {
      userId: 'u',
      name: '房主',
      role: 'host',
      text: `消息 ${index}`,
    });
  }
  assert.equal(room.chat.length, 100);
  assert.equal(room.chat[0].text, '消息 5');
  assert.equal(room.chat.at(-1).text, '消息 104');
  assert.equal(app.store.chatHistory(room).length, 50);
  assert.equal(app.store.chatHistory(room).at(-1).text, '消息 104');
});
