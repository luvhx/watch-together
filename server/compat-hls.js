import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isMetadataAddress, isPrivateAddress } from './embedded-subtitles.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED_FILE = /^(index\.m3u8|init\.mp4|seg-\d{5}\.m4s)$/;
const PLAYLIST_START_TIMEOUT_MS = 45_000;
const JOB_MAX_AGE_MS = 90 * 60 * 1_000;
const JOB_IDLE_MS = 20 * 60 * 1_000;
const MAX_STDERR_BYTES = 8 * 1_024;

export class CompatHlsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CompatHlsError';
    this.status = status;
    this.code = code;
  }
}

function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentTypeFor(name) {
  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (name.endsWith('.m4s')) return 'video/iso.segment';
  return 'video/mp4';
}

export function parseVideoCodec(stdout) {
  try {
    const payload = JSON.parse(String(stdout));
    const stream = payload?.streams?.[0];
    return {
      codec: stream?.codec_name || 'unknown',
      pixelFormat: stream?.pix_fmt || '',
    };
  } catch {
    const lines = String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      codec: lines[0] || 'unknown',
      pixelFormat: lines[1] || '',
    };
  }
}

export function buildHlsArgs(videoUrl, codec) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-user_agent',
    USER_AGENT,
    '-rw_timeout',
    '30000000',
    '-protocol_whitelist',
    'http,https,tcp,tls,crypto',
    '-i',
    videoUrl,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
  ];

  if (codec === 'h264' || codec === 'hevc') {
    args.push('-c:v', 'copy');
    if (codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    // Safari 不支持 MKV，也不一定能解码冷门视频编码；兜底转 H.264。
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '24',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
      '-level',
      '4.1',
    );
  }

  args.push(
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ac',
    '2',
    '-max_muxing_queue_size',
    '2048',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_flags',
    'independent_segments+temp_file',
    '-hls_segment_filename',
    'seg-%05d.m4s',
    'index.m3u8',
  );

  return args;
}

function captureProcess(spawnProcess, command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    const errors = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_024 * 1_024) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (errors.length < 20) errors.push(chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      finish(
        new CompatHlsError(
          error.code === 'ENOENT' ? 503 : 502,
          error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'COMPAT_START_FAILED',
          error.code === 'ENOENT'
            ? '服务器未安装 FFmpeg，无法使用兼容模式'
            : '兼容模式启动失败',
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      if (timedOut) {
        finish(new CompatHlsError(504, 'FFMPEG_TIMEOUT', '读取影片信息超时'));
        return;
      }
      if (code !== 0) {
        finish(
          new CompatHlsError(
            422,
            'MEDIA_PROBE_FAILED',
            '无法读取影片编码信息，兼容模式启动失败',
          ),
        );
        return;
      }
      finish(null, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * 可选的兼容模式：把原片重新封装/转码成 HLS，供不支持 MKV 的 Safari 播放。
 * 视频通常直接 copy，只有音频固定转 AAC，因此首次准备通常比全量转码快。
 */
export class CompatHlsService {
  constructor({
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
    allowPrivateMedia = true,
    lookup = dnsLookup,
    spawnProcess = spawn,
    logger = console,
    maxJobs = 2,
    rootDir = join(tmpdir(), 'watch-together-hls'),
    playlistTimeoutMs = PLAYLIST_START_TIMEOUT_MS,
  } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.allowPrivateMedia = Boolean(allowPrivateMedia);
    this.lookup = lookup;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.maxJobs = maxJobs;
    this.rootDir = rootDir;
    this.playlistTimeoutMs = playlistTimeoutMs;
    this.jobs = new Map();
    this.codecCache = new Map();
    this.children = new Set();
    this.sweeper = setInterval(() => {
      this.sweep().catch(() => {});
    }, 5 * 60 * 1_000);
    this.sweeper.unref?.();
  }

  async assertSafeUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new CompatHlsError(400, 'INVALID_MEDIA_URL', '影片地址无效');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new CompatHlsError(400, 'INVALID_MEDIA_URL', '影片地址必须使用 HTTP(S)');
    }
    if (url.username || url.password) {
      throw new CompatHlsError(400, 'INVALID_MEDIA_URL', '影片地址不能包含认证信息');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!this.allowPrivateMedia && isLocalHostname(hostname)) {
      throw new CompatHlsError(400, 'PRIVATE_MEDIA_URL', '不允许读取内网影片地址');
    }

    let addresses;
    if (isIP(hostname)) {
      addresses = [{ address: hostname }];
    } else {
      try {
        addresses = await this.lookup(hostname, { all: true, verbatim: true });
      } catch {
        throw new CompatHlsError(422, 'MEDIA_UNREACHABLE', '无法解析影片地址');
      }
    }
    if (!addresses.length) {
      throw new CompatHlsError(422, 'MEDIA_UNREACHABLE', '无法解析影片地址');
    }
    if (addresses.some((item) => isMetadataAddress(item.address))) {
      throw new CompatHlsError(400, 'BLOCKED_MEDIA_ADDRESS', '不允许读取云 metadata 地址');
    }
    if (
      !this.allowPrivateMedia &&
      addresses.some((item) => isPrivateAddress(item.address))
    ) {
      throw new CompatHlsError(400, 'PRIVATE_MEDIA_URL', '不允许读取内网影片地址');
    }
    return url.href;
  }

  async probeCodec(rawUrl) {
    const cached = this.codecCache.get(rawUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.info;

    const url = await this.assertSafeUrl(rawUrl);
    const stdout = await captureProcess(
      this.spawnProcess,
      this.ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,pix_fmt',
        '-of',
        'json',
        '-user_agent',
        USER_AGENT,
        '-rw_timeout',
        '20000000',
        '-protocol_whitelist',
        'http,https,tcp,tls,crypto',
        '-i',
        url,
      ],
      30_000,
    );
    const info = parseVideoCodec(stdout);
    if (info.codec === 'unknown') {
      throw new CompatHlsError(422, 'MEDIA_PROBE_FAILED', '影片中没有可播放的视频轨');
    }
    this.codecCache.set(rawUrl, {
      info,
      expiresAt: Date.now() + 10 * 60 * 1_000,
    });
    if (this.codecCache.size > 30) {
      this.codecCache.delete(this.codecCache.keys().next().value);
    }
    return info;
  }

  async ensureJob(roomId, videoUrl) {
    const existing = this.jobs.get(roomId);
    if (existing && existing.videoUrl === videoUrl && !existing.error) {
      existing.lastAccess = Date.now();
      return existing;
    }
    if (existing) await this.removeJob(roomId);

    if (this.jobs.size >= this.maxJobs) {
      await this.sweep(true);
      if (this.jobs.size >= this.maxJobs) {
        throw new CompatHlsError(
          503,
          'COMPAT_BUSY',
          '兼容模式正在准备其他影片，请稍后再试',
        );
      }
    }

    const url = await this.assertSafeUrl(videoUrl);
    const videoInfo = await this.probeCodec(videoUrl);
    await mkdir(this.rootDir, { recursive: true });
    const dir = await mkdtemp(join(this.rootDir, 'job-'));

    const job = {
      roomId,
      videoUrl,
      dir,
      codec: videoInfo.codec,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      finished: false,
      error: null,
      stderr: '',
      child: null,
    };
    this.jobs.set(roomId, job);

    const args = buildHlsArgs(url, videoInfo.codec);
    let child;
    try {
      child = this.spawnProcess(this.ffmpegPath, args, {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      job.error = new CompatHlsError(
        503,
        'COMPAT_START_FAILED',
        '兼容模式启动失败，服务器可能缺少 FFmpeg',
      );
      job.finished = true;
      throw job.error;
    }
    job.child = child;
    this.children.add(child);
    child.stderr?.on('data', (chunk) => {
      if (job.stderr.length < MAX_STDERR_BYTES) {
        job.stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - job.stderr.length);
      }
    });
    child.on('error', (error) => {
      this.children.delete(child);
      job.finished = true;
      job.error = new CompatHlsError(
        error.code === 'ENOENT' ? 503 : 502,
        error.code === 'ENOENT' ? 'FFMPEG_UNAVAILABLE' : 'COMPAT_START_FAILED',
        error.code === 'ENOENT'
          ? '服务器未安装 FFmpeg，无法使用兼容模式'
          : '兼容模式启动失败',
      );
    });
    child.on('close', (code) => {
      this.children.delete(child);
      job.finished = true;
      if (code !== 0 && !job.error) {
        job.error = new CompatHlsError(
          502,
          'COMPAT_FAILED',
          '兼容模式处理影片失败，可能是片源不可访问或编码不支持',
        );
        if (job.stderr) this.logger.warn?.(`[compat] ${job.stderr.slice(0, 500)}`);
      }
    });
    return job;
  }

  async waitForPlaylist(job) {
    const deadline = Date.now() + this.playlistTimeoutMs;
    const playlistPath = join(job.dir, 'index.m3u8');
    while (Date.now() < deadline) {
      if (job.error) throw job.error;
      try {
        const playlist = await readFile(playlistPath, 'utf8');
        if (playlist.includes('#EXTINF') || playlist.includes('#EXT-X-ENDLIST')) {
          return playlist;
        }
      } catch {
        // 还没生成。
      }
      if (job.finished && !job.error) {
        try {
          const playlist = await readFile(playlistPath, 'utf8');
          if (playlist.trim()) return playlist;
        } catch {
          // fall through
        }
        throw new CompatHlsError(502, 'COMPAT_FAILED', '兼容模式没有生成播放清单');
      }
      await delay(120);
    }
    throw new CompatHlsError(
      504,
      'COMPAT_TIMEOUT',
      '兼容模式准备超时，请稍后重试；大文件首次准备可能需要更久',
    );
  }

  async playlist(roomId, videoUrl) {
    const job = await this.ensureJob(roomId, videoUrl);
    const playlist = await this.waitForPlaylist(job);
    job.lastAccess = Date.now();
    return playlist;
  }

  async file(roomId, name) {
    if (!ALLOWED_FILE.test(name)) return null;
    const job = this.jobs.get(roomId);
    if (!job) return null;
    const path = join(job.dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      job.lastAccess = Date.now();
      return {
        path,
        size: info.size,
        type: contentTypeFor(name),
      };
    } catch {
      return null;
    }
  }

  stream(file) {
    return createReadStream(file.path, {
      start: Number.isInteger(file.start) ? file.start : 0,
      end: Number.isInteger(file.end) ? file.end : undefined,
    });
  }

  async removeJob(roomId) {
    const job = this.jobs.get(roomId);
    if (!job) return;
    this.jobs.delete(roomId);
    try {
      job.child?.kill('SIGKILL');
    } catch {
      // ignore
    }
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  async sweep(force = false) {
    const now = Date.now();
    const stale = [];
    for (const [roomId, job] of this.jobs) {
      const tooOld = now - job.createdAt > JOB_MAX_AGE_MS;
      const idle = job.finished && now - job.lastAccess > JOB_IDLE_MS;
      if (tooOld || idle || (force && job.finished)) stale.push(roomId);
    }
    for (const roomId of stale) await this.removeJob(roomId);
  }

  async close() {
    clearInterval(this.sweeper);
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.children.clear();
    const dirs = [...this.jobs.values()].map((job) => job.dir);
    this.jobs.clear();
    this.codecCache.clear();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
  }
}
