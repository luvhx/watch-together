import { spawn } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const FFMPEG_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SUPPORTED_CODECS = new Set([
  'ass',
  'ssa',
  'subrip',
  'srt',
  'webvtt',
  'mov_text',
  'text',
]);
const MAX_OUTPUT_BYTES = 12 * 1_024 * 1_024;
const MAX_EXTRACT_CACHE_BYTES = 48 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 64 * 1_024;
const PROBE_CACHE_MS = 10 * 60 * 1_000;
const EXTRACT_CACHE_MS = 30 * 60 * 1_000;

const LANGUAGE_NAMES = {
  zh: '中文',
  chi: '中文',
  zho: '中文',
  'zh-cn': '简体中文',
  'zh-tw': '繁体中文',
  ja: '日语',
  jpn: '日语',
  en: '英语',
  eng: '英语',
  ko: '韩语',
  kor: '韩语',
};

export class EmbeddedSubtitleError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EmbeddedSubtitleError';
    this.status = status;
    this.code = code;
  }
}

function languageLabel(language) {
  if (!language) return '';
  return LANGUAGE_NAMES[language.toLowerCase()] || language.toUpperCase();
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isPrivateAddress(address) {
  const normalized = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version !== 6) return true;

  if (normalized === '::' || normalized === '::1') return true;
  if (normalized === 'fd00:ec2::254') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  return false;
}

function isDangerousIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    address === '100.100.100.200' ||
    address === '168.63.129.16' ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isDangerousAddress(address) {
  const normalized = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return isDangerousIpv4(normalized);
  if (version !== 6) return true;

  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isDangerousIpv4(mapped);
  }
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  return false;
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

function sanitizeFilename(value) {
  const clean = String(value || 'subtitle')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 80) || 'subtitle';
}

export function parseFfprobeStreams(payload) {
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  return streams
    .filter(
      (stream) =>
        stream?.codec_type === 'subtitle' && Number.isInteger(Number(stream.index)),
    )
    .map((stream, index) => {
      const tags = stream.tags || {};
      const codec = stream.codec_name || 'unknown';
      const supported = SUPPORTED_CODECS.has(codec);
      const language = String(tags.language || '').trim();
      const title = String(tags.title || '').trim();
      const fallback = languageLabel(language) || `字幕 ${index + 1}`;
      const label = title || fallback;
      return {
        id: index,
        streamIndex: Number(stream.index),
        codec,
        language,
        languageLabel: languageLabel(language),
        title,
        label: supported ? label : `${label}（图形字幕不支持）`,
        supported,
        default: Boolean(stream.disposition?.default),
      };
    });
}

function createProcessRunner(spawnProcess) {
  return function run(command, args, { timeoutMs, maxOutputBytes = MAX_OUTPUT_BYTES }) {
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

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let tooLarge = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, timeoutMs);
      timer.unref?.();

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };

      child.stdout?.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          tooLarge = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(chunk.length, remaining);
      });
      child.on('error', (error) => {
        if (error.code === 'ENOENT') {
          finish(
            new EmbeddedSubtitleError(
              503,
              'FFMPEG_UNAVAILABLE',
              '服务器未安装 FFmpeg，无法读取内封字幕',
            ),
          );
        } else {
          finish(error);
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (timedOut) {
          finish(
            new EmbeddedSubtitleError(
              504,
              'FFMPEG_TIMEOUT',
              '读取内封字幕超时，请稍后重试',
            ),
          );
          return;
        }
        if (tooLarge) {
          finish(
            new EmbeddedSubtitleError(
              413,
              'SUBTITLE_TOO_LARGE',
              '字幕文件过大，暂不支持',
            ),
          );
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        if (code !== 0) {
          finish(
            new EmbeddedSubtitleError(
              422,
              'SUBTITLE_PROBE_FAILED',
              '无法读取影片中的内封字幕',
            ),
          );
          return;
        }
        finish(null, { stdout: Buffer.concat(stdoutChunks), stderr });
      });
    });
  };
}

/**
 * 通过 FFprobe 读取远程影片流中的字幕轨，并通过 FFmpeg 按需转成 ASS。
 * 浏览器无法从 MKV 的 <video> 元素读取内封轨道，所以这一步必须发生在服务端。
 */
export class EmbeddedSubtitleService {
  constructor({
    ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
    logger = console,
    lookup = dnsLookup,
    spawnProcess = spawn,
    probeTimeoutMs = 25_000,
    extractTimeoutMs = 120_000,
    maxConcurrent = 2,
    allowPrivateMedia = true,
  } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.logger = logger;
    this.lookup = lookup;
    this.spawnProcess = spawnProcess;
    this.probeTimeoutMs = probeTimeoutMs;
    this.extractTimeoutMs = extractTimeoutMs;
    this.maxConcurrent = maxConcurrent;
    this.allowPrivateMedia = Boolean(allowPrivateMedia);
    this.active = 0;
    this.waiters = [];
    this.probeCache = new Map();
    this.extractCache = new Map();
    this.extractCacheBytes = 0;
    this.children = new Set();
    this.runProcess = createProcessRunner((command, args, options) => {
      const child = spawnProcess(command, args, options);
      this.children.add(child);
      child.once?.('close', () => this.children.delete(child));
      child.once?.('error', () => this.children.delete(child));
      return child;
    });
  }

  async withSlot(callback) {
    if (this.active >= this.maxConcurrent) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await callback();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  async assertSafeUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new EmbeddedSubtitleError(400, 'INVALID_MEDIA_URL', '影片地址无效');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new EmbeddedSubtitleError(400, 'INVALID_MEDIA_URL', '影片地址必须使用 HTTP(S)');
    }
    if (url.username || url.password) {
      throw new EmbeddedSubtitleError(400, 'INVALID_MEDIA_URL', '影片地址不能包含认证信息');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!this.allowPrivateMedia && isLocalHostname(hostname)) {
      throw new EmbeddedSubtitleError(400, 'PRIVATE_MEDIA_URL', '不允许读取内网影片地址');
    }

    let addresses;
    if (isIP(hostname)) {
      addresses = [{ address: hostname }];
    } else {
      try {
        addresses = await this.lookup(hostname, { all: true, verbatim: true });
      } catch {
        throw new EmbeddedSubtitleError(422, 'MEDIA_UNREACHABLE', '无法解析影片地址');
      }
    }
    if (!addresses.length) {
      throw new EmbeddedSubtitleError(422, 'MEDIA_UNREACHABLE', '无法解析影片地址');
    }
    if (addresses.some((item) => isDangerousAddress(item.address))) {
      throw new EmbeddedSubtitleError(
        400,
        'BLOCKED_MEDIA_ADDRESS',
        '不允许读取回环、链路本地或保留影片地址',
      );
    }
    if (
      !this.allowPrivateMedia &&
      addresses.some((item) => isPrivateAddress(item.address))
    ) {
      throw new EmbeddedSubtitleError(400, 'PRIVATE_MEDIA_URL', '不允许读取内网影片地址');
    }
    return url.href;
  }

  async probe(rawUrl) {
    const cached = this.probeCache.get(rawUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.tracks;

    const url = await this.assertSafeUrl(rawUrl);
    const tracks = await this.withSlot(async () => {
      const { stdout } = await this.runProcess(
        this.ffprobePath,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_streams',
          '-user_agent',
          FFMPEG_USER_AGENT,
          '-rw_timeout',
          '20000000',
          '-protocol_whitelist',
          'http,https,tcp,tls,crypto',
          '-i',
          url,
        ],
        { timeoutMs: this.probeTimeoutMs, maxOutputBytes: 2 * 1_024 * 1_024 },
      );
      let payload;
      try {
        payload = JSON.parse(stdout.toString('utf8'));
      } catch {
        throw new EmbeddedSubtitleError(
          422,
          'SUBTITLE_PROBE_FAILED',
          'FFprobe 返回了无法识别的数据',
        );
      }
      return parseFfprobeStreams(payload);
    });

    this.probeCache.set(rawUrl, {
      tracks,
      expiresAt: Date.now() + PROBE_CACHE_MS,
    });
    if (this.probeCache.size > 50) {
      const oldest = this.probeCache.keys().next().value;
      this.probeCache.delete(oldest);
    }
    return tracks;
  }

  async extract(rawUrl, streamId) {
    const cacheKey = `${rawUrl}#${streamId}`;
    const cached = this.extractCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) {
      this.extractCache.delete(cacheKey);
      this.extractCacheBytes -= cached.result.buffer.length;
    }

    const tracks = await this.probe(rawUrl);
    const track = tracks.find((item) => item.id === Number(streamId));
    if (!track) {
      throw new EmbeddedSubtitleError(404, 'SUBTITLE_TRACK_NOT_FOUND', '字幕轨不存在');
    }
    if (!track.supported) {
      throw new EmbeddedSubtitleError(
        422,
        'SUBTITLE_UNSUPPORTED',
        '这是一条图形字幕轨，暂不支持提取',
      );
    }

    const url = await this.assertSafeUrl(rawUrl);
    const result = await this.withSlot(async () => {
      const { stdout } = await this.runProcess(
        this.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-user_agent',
          FFMPEG_USER_AGENT,
          '-rw_timeout',
          '30000000',
          '-protocol_whitelist',
          'http,https,tcp,tls,crypto',
          '-i',
          url,
          '-map',
          `0:${track.streamIndex}`,
          '-c:s',
          track.codec === 'ass' || track.codec === 'ssa' ? 'copy' : 'ass',
          '-f',
          'ass',
          'pipe:1',
        ],
        { timeoutMs: this.extractTimeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES },
      );
      const text = stdout.toString('utf8').trim();
      if (!text || !/\[Events\]/i.test(text)) {
        throw new EmbeddedSubtitleError(
          422,
          'SUBTITLE_EMPTY',
          '这条字幕轨没有可提取的文字内容',
        );
      }
      const filename = `${sanitizeFilename(track.title || track.languageLabel || '内封字幕')}.ass`;
      return {
        buffer: Buffer.from(text, 'utf8'),
        filename,
        format: 'ass',
        codec: track.codec,
      };
    });

    this.extractCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + EXTRACT_CACHE_MS,
    });
    this.extractCacheBytes += result.buffer.length;
    while (
      this.extractCache.size > 0 &&
      (this.extractCache.size > 12 ||
        this.extractCacheBytes > MAX_EXTRACT_CACHE_BYTES)
    ) {
      const oldestKey = this.extractCache.keys().next().value;
      const oldest = this.extractCache.get(oldestKey);
      this.extractCache.delete(oldestKey);
      this.extractCacheBytes -= oldest?.result.buffer.length || 0;
    }
    return result;
  }

  close() {
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.children.clear();
    this.probeCache.clear();
    this.extractCache.clear();
    this.extractCacheBytes = 0;
  }
}
