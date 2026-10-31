import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRoom, startTestApp } from './helpers.js';

test('兼容模式 HLS 清单、分片和 Range', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wt-compat-api-'));
  const segmentPath = join(root, 'seg-00000.m4s');
  const payload = Buffer.from('0123456789abcdef');
  await writeFile(segmentPath, payload);
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  const fake = {
    async playlist(roomId, videoUrl) {
      calls.push(['playlist', roomId, videoUrl]);
      return '#EXTM3U\n#EXT-X-VERSION:7\n#EXTINF:4.0,\nseg-00000.m4s\n#EXT-X-ENDLIST\n';
    },
    async file(roomId, name) {
      if (name !== 'seg-00000.m4s') return null;
      return { path: segmentPath, size: payload.length, type: 'video/iso.segment' };
    },
    stream(file) {
      return createReadStream(file.path, {
        start: file.start,
        end: file.end,
      });
    },
    async removeJob() {},
    async close() {},
  };
  const app = await startTestApp({}, { compatHls: fake });
  t.after(() => app.close());
  const { payload: room } = await createRoom(app.baseUrl, {
    videoUrl: 'https://cdn.example.com/episode.mkv',
  });

  const playlist = await fetch(
    `${app.baseUrl}/api/rooms/${room.roomId}/compat/index.m3u8`,
  );
  assert.equal(playlist.status, 200);
  assert.match(playlist.headers.get('content-type'), /mpegurl/);
  assert.match(await playlist.text(), /#EXTM3U/);
  assert.deepEqual(calls[0], [
    'playlist',
    room.roomId,
    'https://cdn.example.com/episode.mkv',
  ]);

  const range = await fetch(
    `${app.baseUrl}/api/rooms/${room.roomId}/compat/seg-00000.m4s`,
    { headers: { Range: 'bytes=4-9' } },
  );
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 4-9/16');
  assert.equal(range.headers.get('accept-ranges'), 'bytes');
  assert.equal(await range.text(), '456789');

  const missing = await fetch(
    `${app.baseUrl}/api/rooms/${room.roomId}/compat/seg-99999.m4s`,
  );
  assert.equal(missing.status, 404);
});
