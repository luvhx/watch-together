import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildHlsArgs,
  CompatHlsService,
  parseVideoCodec,
} from '../server/compat-hls.js';

test('解析视频编码并选择 HLS 封装参数', () => {
  assert.deepEqual(
    parseVideoCodec('{"streams":[{"codec_name":"hevc","pix_fmt":"yuv420p10le"}]}'),
    { codec: 'hevc', pixelFormat: 'yuv420p10le' },
  );
  assert.equal(parseVideoCodec('h264\nyuv420p').codec, 'h264');

  const hevc = buildHlsArgs('https://example.com/a.mkv', 'hevc');
  assert.ok(hevc.includes('copy'));
  assert.ok(hevc.includes('hvc1'));

  const h264 = buildHlsArgs('https://example.com/a.mkv', 'h264');
  assert.ok(h264.includes('copy'));
  assert.ok(!h264.includes('hvc1'));

  const av1 = buildHlsArgs('https://example.com/a.mkv', 'av1');
  assert.ok(av1.includes('libx264'));
  assert.ok(!av1.includes('copy'));
  for (const args of [hevc, h264, av1]) {
    assert.ok(args.includes('fmp4'));
    assert.ok(args.includes('event'));
  }
});

test('兼容模式地址策略与内封字幕一致', async (t) => {
  const service = new CompatHlsService({
    lookup: async () => [{ address: '10.1.2.3', family: 4 }],
  });
  t.after(async () => service.close());
  await service.assertSafeUrl('http://10.1.2.3/movie.mkv');
  await service.assertSafeUrl('http://127.0.0.1/movie.mkv');
  await assert.rejects(
    service.assertSafeUrl('http://169.254.169.254/latest/meta-data'),
    (error) => error.code === 'BLOCKED_MEDIA_ADDRESS',
  );

  const strict = new CompatHlsService({
    allowPrivateMedia: false,
    lookup: async () => [{ address: '10.1.2.3', family: 4 }],
  });
  t.after(async () => strict.close());
  await assert.rejects(
    strict.assertSafeUrl('http://10.1.2.3/movie.mkv'),
    (error) => error.code === 'PRIVATE_MEDIA_URL',
  );
});

function makeFakeProcess(writes, behavior = 'ok') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(async () => {
    if (behavior === 'error') {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      return;
    }
    await writes?.();
    child.emit('close', 0);
  });
  return child;
}

test('启动 FFmpeg、生成清单并读取分片', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wt-compat-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new CompatHlsService({
    rootDir: root,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    spawnProcess(_command, _args, options) {
      return makeFakeProcess(async () => {
        await writeFile(join(options.cwd, 'init.mp4'), 'init');
        await writeFile(join(options.cwd, 'seg-00000.m4s'), 'segment');
        await writeFile(
          join(options.cwd, 'index.m3u8'),
          '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg-00000.m4s\n#EXT-X-ENDLIST\n',
        );
      });
    },
    playlistTimeoutMs: 2_000,
  });
  t.after(async () => service.close());
  // 用 fake ffprobe 的命令名无法区分；直接给服务一个固定 probe 结果。
  service.probeCodec = async () => ({ codec: 'hevc', pixelFormat: 'yuv420p10le' });
  const job = await service.ensureJob('room12345', 'https://example.com/a.mkv');
  assert.equal(job.codec, 'hevc');
  const playlist = await service.waitForPlaylist(job);
  assert.match(playlist, /#EXTM3U/);
  const segment = await service.file('room12345', 'seg-00000.m4s');
  assert.ok(segment);
  assert.equal(segment.type, 'video/iso.segment');
  assert.equal(segment.size, 7);
  const playlistFile = await readFile(join(job.dir, 'index.m3u8'), 'utf8');
  assert.match(playlistFile, /seg-00000/);
  await service.removeJob('room12345');
  assert.equal(await service.file('room12345', 'seg-00000.m4s'), null);
});
