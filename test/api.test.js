import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoom, startTestApp } from './helpers.js';

test('房间 HTTP API 完整生命周期', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const health = await fetch(`${app.baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const { response, payload } = await createRoom(app.baseUrl);
  assert.equal(response.status, 201);
  assert.match(payload.roomId, /^[a-z2-9]{8}$/);
  assert.ok(payload.hostKey.length > 30);
  assert.equal(payload.room.title, '周五电影夜');
  assert.equal(payload.room.hostOnline, false);
  assert.equal(payload.room.playback.position, 0);
  assert.equal('hostKeyHash' in payload.room, false);
  assert.equal('hostKey' in payload.room, false);

  const lookup = await fetch(`${app.baseUrl}/api/rooms/${payload.roomId}`);
  assert.equal(lookup.status, 200);
  const lookupBody = await lookup.json();
  assert.equal(lookupBody.room.id, payload.roomId);
  assert.equal('hostKey' in lookupBody.room, false);

  const noStore = await fetch(`${app.baseUrl}/api/rooms/${payload.roomId}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer wrong-key' },
  });
  assert.equal(noStore.status, 403);

  const deleted = await fetch(`${app.baseUrl}/api/rooms/${payload.roomId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${payload.hostKey}` },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });

  const gone = await fetch(`${app.baseUrl}/api/rooms/${payload.roomId}`);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error.code, 'ROOM_NOT_FOUND');
});

test('非法直链和请求体被拒绝', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const badScheme = await createRoom(app.baseUrl, {
    videoUrl: 'javascript:alert(1)',
  });
  assert.equal(badScheme.response.status, 400);
  assert.equal(badScheme.payload.error.code, 'INVALID_VIDEO_URL');

  const missingVideo = await createRoom(app.baseUrl, { videoUrl: '' });
  assert.equal(missingVideo.response.status, 400);

  const badJson = await fetch(`${app.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{oops',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'INVALID_JSON');

  const wrongType = await fetch(`${app.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(wrongType.status, 415);

  const tooLarge = await fetch(`${app.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl: `https://a.test/${'a'.repeat(20_000)}` }),
  });
  assert.equal(tooLarge.status, 413);
});

test('邀请链接重定向、安全响应头和 HLS 资源', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const { payload } = await createRoom(app.baseUrl);

  const invite = await fetch(`${app.baseUrl}/r/${payload.roomId}`, {
    redirect: 'manual',
  });
  assert.equal(invite.status, 302);
  assert.equal(invite.headers.get('location'), `/?room=${payload.roomId}`);

  const home = await fetch(app.baseUrl);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(await home.text(), /一起看/);

  const hls = await fetch(`${app.baseUrl}/vendor/hls.min.js`);
  assert.equal(hls.status, 200);
  assert.match(hls.headers.get('content-type'), /javascript/);
  assert.match(hls.headers.get('cache-control'), /immutable/);
  await hls.arrayBuffer();

  const subtitlesModule = await fetch(`${app.baseUrl}/subtitles.js`);
  assert.equal(subtitlesModule.status, 200);
  assert.match(subtitlesModule.headers.get('content-type'), /javascript/);
  await subtitlesModule.arrayBuffer();

  const removedAvatar = await fetch(`${app.baseUrl}/contributor-avatar.svg`);
  assert.equal(removedAvatar.status, 404);

  const demoAss = await fetch(`${app.baseUrl}/subtitles/demo.ass`);
  assert.equal(demoAss.status, 200);
  assert.match(demoAss.headers.get('content-type'), /text\/plain/);
  assert.match(await demoAss.text(), /\[Events\]/);

  const traversal = await fetch(`${app.baseUrl}/..%2fpackage.json`);
  assert.equal(traversal.status, 404);
});

test('健康检查不缓存', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const response = await fetch(`${app.baseUrl}/api/health`);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('跨站创建请求和畸形房间路径会被拒绝', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  const crossSite = await fetch(`${app.baseUrl}/api/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
    },
    body: JSON.stringify({ videoUrl: 'https://cdn.example.com/a.mp4' }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, 'BAD_ORIGIN');

  const malformed = await fetch(`${app.baseUrl}/api/rooms/%E0%A4%A`);
  assert.equal(malformed.status, 404);
});
