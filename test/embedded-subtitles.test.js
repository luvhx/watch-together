import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { loadConfig } from '../server/config.js';

import {
  EmbeddedSubtitleError,
  EmbeddedSubtitleService,
  isMetadataAddress,
  isPrivateAddress,
  parseFfprobeStreams,
} from '../server/embedded-subtitles.js';

const PROBE_JSON = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    {
      index: 2,
      codec_type: 'subtitle',
      codec_name: 'ass',
      tags: { language: 'zh', title: '简体中文' },
      disposition: { default: 1 },
    },
    {
      index: 3,
      codec_type: 'subtitle',
      codec_name: 'subrip',
      tags: { language: 'eng' },
      disposition: { default: 0 },
    },
    {
      index: 4,
      codec_type: 'subtitle',
      codec_name: 'hdmv_pgs_subtitle',
      tags: { language: 'jpn' },
    },
  ],
};

const ASS_OUTPUT = `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,内封字幕
`;

function fakeChild({ stdout = '', stderr = '', code = 0, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    process.nextTick(() => child.emit('close', -1));
  };
  process.nextTick(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

function createService({
  probeJson = PROBE_JSON,
  ffmpegOutput = ASS_OUTPUT,
  error,
  allowPrivateMedia = true,
} = {}) {
  const calls = [];
  const service = new EmbeddedSubtitleService({
    ffmpegPath: 'fake-ffmpeg',
    ffprobePath: 'fake-ffprobe',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    allowPrivateMedia,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      if (error) return fakeChild({ error });
      if (command === 'fake-ffprobe') {
        return fakeChild({ stdout: JSON.stringify(probeJson) });
      }
      return fakeChild({ stdout: ffmpegOutput });
    },
  });
  return { service, calls };
}

test('解析 FFprobe 字幕轨并标记图形字幕', () => {
  const tracks = parseFfprobeStreams(PROBE_JSON);
  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].id, 0);
  assert.equal(tracks[0].streamIndex, 2);
  assert.equal(tracks[0].codec, 'ass');
  assert.equal(tracks[0].label, '简体中文');
  assert.equal(tracks[0].supported, true);
  assert.equal(tracks[0].default, true);
  assert.equal(tracks[1].label, '英语');
  assert.equal(tracks[2].supported, false);
  assert.match(tracks[2].label, /不支持/);
});

test('探测和提取内封字幕并缓存结果', async (t) => {
  const { service, calls } = createService();
  t.after(() => service.close());

  const tracks = await service.probe('https://example.com/movie.mkv');
  assert.equal(tracks.length, 3);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('https://example.com/movie.mkv'));

  await service.probe('https://example.com/movie.mkv');
  assert.equal(calls.length, 1);

  const result = await service.extract('https://example.com/movie.mkv', 0);
  assert.equal(result.format, 'ass');
  assert.match(result.filename, /\.ass$/);
  assert.match(result.buffer.toString('utf8'), /内封字幕/);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('0:2'));
  assert.ok(calls[1].args.includes('copy'));

  await service.extract('https://example.com/movie.mkv', 0);
  assert.equal(calls.length, 2);
});

test('图形字幕拒绝提取，空字幕输出报错', async (t) => {
  const { service } = createService();
  t.after(() => service.close());
  await assert.rejects(
    service.extract('https://example.com/movie.mkv', 2),
    (error) =>
      error instanceof EmbeddedSubtitleError &&
      error.code === 'SUBTITLE_UNSUPPORTED',
  );

  const empty = createService({ ffmpegOutput: '' });
  t.after(() => empty.service.close());
  await assert.rejects(
    empty.service.extract('https://example.com/movie.mkv', 0),
    (error) =>
      error instanceof EmbeddedSubtitleError && error.code === 'SUBTITLE_EMPTY',
  );
});

test('默认放行局域网、本机与 fake-IP，拦截云 metadata', async (t) => {
  const { service, calls } = createService();
  t.after(() => service.close());

  await assert.rejects(
    service.probe('http://169.254.169.254/latest/meta-data'),
    (error) =>
      error instanceof EmbeddedSubtitleError &&
      error.code === 'BLOCKED_MEDIA_ADDRESS',
  );
  await assert.rejects(
    service.probe('http://100.100.100.200/latest/meta-data'),
    (error) => error.code === 'BLOCKED_MEDIA_ADDRESS',
  );
  assert.equal(calls.length, 0);

  const lan = await service.probe('http://10.0.0.5/movie.mkv');
  assert.equal(lan.length, 3);
  assert.ok(calls[0].args.includes('http://10.0.0.5/movie.mkv'));
  const loopback = await service.probe('http://127.0.0.1/movie.mkv');
  assert.equal(loopback.length, 3);
  const fakeIp = await service.probe('http://198.18.0.1/movie.mkv');
  assert.equal(fakeIp.length, 3);
  assert.equal(calls.length, 3);

  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.4'), true);
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  assert.equal(isMetadataAddress('169.254.169.254'), true);
  assert.equal(isMetadataAddress('100.100.100.200'), true);
  assert.equal(isMetadataAddress('fd00:ec2::254'), true);
  assert.equal(isMetadataAddress('10.0.0.1'), false);
});

test('ALLOW_PRIVATE_MEDIA 默认开启并可关闭', () => {
  assert.equal(loadConfig({}).allowPrivateMedia, true);
  assert.equal(loadConfig({ ALLOW_PRIVATE_MEDIA: '0' }).allowPrivateMedia, false);
  assert.equal(loadConfig({ ALLOW_PRIVATE_MEDIA: '1' }).allowPrivateMedia, true);
});

test('ALLOW_PRIVATE_MEDIA=0 时拒绝内网地址', async (t) => {
  const { service, calls } = createService({ allowPrivateMedia: false });
  t.after(() => service.close());

  await assert.rejects(
    service.probe('http://10.0.0.5/movie.mkv'),
    (error) =>
      error instanceof EmbeddedSubtitleError &&
      error.code === 'PRIVATE_MEDIA_URL',
  );
  await assert.rejects(
    service.probe('http://127.0.0.1/movie.mkv'),
    (error) => error.code === 'PRIVATE_MEDIA_URL',
  );
  await assert.rejects(
    service.probe('http://media.internal/movie.mkv'),
    (error) => error.code === 'PRIVATE_MEDIA_URL',
  );
  assert.equal(calls.length, 0);
});

test('FFmpeg 缺失时返回可识别的 503 错误', async (t) => {
  const error = Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
  const { service } = createService({ error });
  t.after(() => service.close());
  await assert.rejects(
    service.probe('https://example.com/movie.mkv'),
    (value) =>
      value instanceof EmbeddedSubtitleError &&
      value.status === 503 &&
      value.code === 'FFMPEG_UNAVAILABLE',
  );
});
