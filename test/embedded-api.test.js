import assert from 'node:assert/strict';
import test from 'node:test';

import { EmbeddedSubtitleError } from '../server/embedded-subtitles.js';
import { createRoom, startTestApp } from './helpers.js';

const ASS = Buffer.from(`[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,内封字幕
`);

test('内封字幕列表与提取接口', async (t) => {
  const calls = [];
  const fakeService = {
    async probe(url) {
      calls.push(['probe', url]);
      return [
        {
          id: 0,
          streamIndex: 2,
          codec: 'ass',
          language: 'zh',
          languageLabel: '中文',
          title: '简体中文',
          label: '简体中文',
          supported: true,
          default: true,
        },
      ];
    },
    async extract(url, id) {
      calls.push(['extract', url, id]);
      if (id !== 0) {
        throw new EmbeddedSubtitleError(404, 'SUBTITLE_TRACK_NOT_FOUND', '字幕轨不存在');
      }
      return {
        buffer: ASS,
        filename: '简体中文.ass',
        format: 'ass',
        codec: 'ass',
      };
    },
    close() {},
  };
  const app = await startTestApp({}, { embeddedSubtitles: fakeService });
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl, {
    videoUrl: 'https://cdn.example.com/episode.mkv',
  });

  const list = await fetch(
    `${app.baseUrl}/api/rooms/${payload.roomId}/embedded-subtitles`,
  );
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.tracks.length, 1);
  assert.equal(body.tracks[0].label, '简体中文');
  assert.deepEqual(calls[0], [
    'probe',
    'https://cdn.example.com/episode.mkv',
  ]);

  const file = await fetch(
    `${app.baseUrl}/api/rooms/${payload.roomId}/embedded-subtitles/0`,
  );
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type'), /text\/plain/);
  assert.match(file.headers.get('content-disposition'), /%E7%AE%80/);
  assert.equal(await file.text(), ASS.toString('utf8'));
  assert.deepEqual(calls[1], [
    'extract',
    'https://cdn.example.com/episode.mkv',
    0,
  ]);

  const missing = await fetch(
    `${app.baseUrl}/api/rooms/${payload.roomId}/embedded-subtitles/9`,
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'SUBTITLE_TRACK_NOT_FOUND');
});

test('内封字幕服务不可用时返回明确错误', async (t) => {
  const fakeService = {
    async probe() {
      throw new EmbeddedSubtitleError(
        503,
        'FFMPEG_UNAVAILABLE',
        '服务器未安装 FFmpeg，无法读取内封字幕',
      );
    },
    async extract() {
      throw new Error('should not be called');
    },
    close() {},
  };
  const app = await startTestApp({}, { embeddedSubtitles: fakeService });
  t.after(() => app.close());
  const { payload } = await createRoom(app.baseUrl);
  const list = await fetch(
    `${app.baseUrl}/api/rooms/${payload.roomId}/embedded-subtitles`,
  );
  assert.equal(list.status, 503);
  const body = await list.json();
  assert.equal(body.error.code, 'FFMPEG_UNAVAILABLE');
  assert.match(body.error.message, /FFmpeg/);
});
