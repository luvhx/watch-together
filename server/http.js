import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EmbeddedSubtitleError } from './embedded-subtitles.js';
import { createRateLimiter } from './rate-limit.js';
import {
  normalizeRoomId,
  normalizeVideoUrl,
  RoomCapacityError,
  ValidationError,
} from './rooms.js';

const require = createRequire(import.meta.url);
const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_JSON_BYTES = 16 * 1_024;

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.vtt', 'text/vtt; charset=utf-8'],
  ['.srt', 'application/x-subrip; charset=utf-8'],
  ['.ass', 'text/plain; charset=utf-8'],
  ['.ssa', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

class HttpError extends Error {
  constructor(status, code, message, headers = {}, expose = false) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.expose = expose;
  }
}

function securityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      'media-src http: https: blob: data:',
      'connect-src http: https: ws: wss:',
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, error, requestId) {
  const status = error.status || 500;
  const code = error.code || 'INTERNAL_ERROR';
  const message =
    status >= 500 && !error.expose
      ? '服务器开小差了，请稍后再试'
      : error.message || '请求失败';
  if (status >= 500) {
    console.error(`[http] ${requestId} ${error.stack || error}`);
  } else if (status === 429) {
    console.warn(`[http] ${requestId} rate limited`);
  }
  sendJson(
    res,
    status,
    { error: { code, message, requestId } },
    error.headers || {},
  );
}

export function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function requestHost(req, config) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-host'];
    if (typeof forwarded === 'string' && forwarded) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.headers.host || '';
}

function hasSameOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === requestHost(req, config);
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 JSON');
  }
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new HttpError(400, 'BAD_REQUEST', '请求体不能为空');

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'JSON 格式不正确');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_JSON', '请求体必须是 JSON 对象');
  }
  return parsed;
}

function rateLimitOrThrow(result) {
  if (result.allowed) return;
  throw new HttpError(429, 'RATE_LIMITED', '操作太频繁，请稍后再试', {
    'Retry-After': String(Math.max(1, Math.ceil(result.retryAfterMs / 1_000))),
  });
}

function parseRoomPath(pathname) {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return normalizeRoomId(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

async function serveHls(req, res) {
  let file;
  try {
    file = require.resolve('hls.js/dist/hls.min.js');
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'HLS 播放器资源不存在');
  }
  await serveFile(req, res, file, {
    cacheControl: 'public, max-age=31536000, immutable',
  });
}

async function serveStatic(req, res, pathname, publicDir) {
  let relative;
  try {
    relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    throw new HttpError(400, 'BAD_PATH', '路径格式不正确');
  }
  if (relative.includes('\0')) throw new HttpError(400, 'BAD_PATH', '路径格式不正确');
  if (relative.split('/').some((part) => part.startsWith('.'))) {
    throw new HttpError(404, 'NOT_FOUND', '资源不存在');
  }

  const filePath = resolve(publicDir, `.${relative}`);
  const root = resolve(publicDir) + sep;
  if (!filePath.startsWith(root)) {
    throw new HttpError(403, 'FORBIDDEN', '禁止访问');
  }
  await serveFile(req, res, filePath, { cacheControl: 'no-cache' });
}

async function serveFile(req, res, filePath, { cacheControl }) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', '资源不存在');
  }
  if (!info.isFile()) throw new HttpError(404, 'NOT_FOUND', '资源不存在');

  const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type':
      CONTENT_TYPES.get(extname(filePath).toLowerCase()) ??
      'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * 创建 HTTP 请求处理器。所有可变状态由外部传入，便于测试和多实例之外的自定义。
 */
export function createHttpHandler({
  store,
  hub,
  config,
  publicDir = DEFAULT_PUBLIC_DIR,
  embeddedSubtitles = null,
  now = Date.now,
}) {
  const createLimiter = createRateLimiter({
    limit: config.createLimitPer10Min,
    windowMs: 10 * 60 * 1_000,
    now,
  });
  const lookupLimiter = createRateLimiter({
    limit: 240,
    windowMs: 60 * 1_000,
    now,
  });
  const embeddedLimiter = createRateLimiter({
    limit: 30,
    windowMs: 60 * 1_000,
    now,
  });
  const embeddedExtractLimiter = createRateLimiter({
    limit: 12,
    windowMs: 10 * 60 * 1_000,
    now,
  });
  let requestCounter = 0;

  return async function handleRequest(req, res) {
    const startedAt = Date.now();
    const requestId = `${startedAt.toString(36)}-${(++requestCounter).toString(36)}`;
    res.setHeader('X-Request-Id', requestId);
    securityHeaders(res);

    let pathname = '/';
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          status: 'ok',
          rooms: store.size,
          uptime: Math.round(process.uptime()),
        });
      }

      if (req.method === 'POST' && pathname === '/api/rooms') {
        if (!hasSameOrigin(req, config)) {
          throw new HttpError(403, 'BAD_ORIGIN', '请求来源不被允许');
        }
        rateLimitOrThrow(createLimiter(clientIp(req, config)));
        const body = await readJsonBody(req);
        let videoUrl;
        try {
          videoUrl = normalizeVideoUrl(body.videoUrl);
        } catch (error) {
          if (error instanceof ValidationError) {
            throw new HttpError(400, 'INVALID_VIDEO_URL', error.message);
          }
          throw error;
        }

        let created;
        try {
          created = store.create({
            videoUrl,
            title: body.title,
            hostName: body.hostName,
          });
        } catch (error) {
          if (error instanceof RoomCapacityError) {
            throw new HttpError(503, 'ROOM_LIMIT', error.message);
          }
          if (error instanceof ValidationError) {
            throw new HttpError(400, 'INVALID_ROOM', error.message);
          }
          throw error;
        }

        res.setHeader('Location', `/r/${created.room.id}`);
        return sendJson(res, 201, {
          roomId: created.room.id,
          hostKey: created.hostKey,
          invitePath: `/r/${created.room.id}`,
          room: store.publicRoom(created.room),
        });
      }

      if (pathname === '/api/rooms' && req.method !== 'POST') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法', {
          Allow: 'POST',
        });
      }


      const embeddedFileMatch = pathname.match(
        /^\/api\/rooms\/([^/]+)\/embedded-subtitles\/(\d+)\/?$/,
      );
      const embeddedListMatch = pathname.match(
        /^\/api\/rooms\/([^/]+)\/embedded-subtitles\/?$/,
      );
      if (embeddedFileMatch || embeddedListMatch) {
        if (req.method !== 'GET') {
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法', {
            Allow: 'GET',
          });
        }
        let roomId;
        try {
          roomId = normalizeRoomId(decodeURIComponent((embeddedFileMatch || embeddedListMatch)[1]));
        } catch {
          roomId = null;
        }
        if (!roomId) throw new HttpError(404, 'ROOM_NOT_FOUND', '房间不存在');
        const room = store.get(roomId);
        if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', '房间不存在或已过期');
        if (!embeddedSubtitles) {
          throw new HttpError(503, 'FFMPEG_UNAVAILABLE', '服务器未启用内封字幕读取', {}, true);
        }

        const ip = clientIp(req, config);
        rateLimitOrThrow(embeddedLimiter(ip));
        try {
          if (embeddedListMatch) {
            const tracks = await embeddedSubtitles.probe(room.videoUrl);
            return sendJson(res, 200, { tracks });
          }

          rateLimitOrThrow(embeddedExtractLimiter(ip));
          const streamId = Number.parseInt(embeddedFileMatch[2], 10);
          const result = await embeddedSubtitles.extract(room.videoUrl, streamId);
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': result.buffer.length,
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
            'Cache-Control': 'private, max-age=600',
            'X-Subtitle-Format': result.format,
          });
          res.end(result.buffer);
          return;
        } catch (error) {
          if (error instanceof EmbeddedSubtitleError) {
            throw new HttpError(error.status, error.code, error.message, {}, true);
          }
          throw error;
        }
      }

      if (pathname.startsWith('/api/rooms/')) {
        const roomId = parseRoomPath(pathname);
        if (!roomId) throw new HttpError(404, 'ROOM_NOT_FOUND', '房间不存在');
        const room = store.get(roomId);
        if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', '房间不存在或已过期');

        if (req.method === 'GET') {
          rateLimitOrThrow(lookupLimiter(clientIp(req, config)));
          return sendJson(res, 200, { room: store.publicRoom(room) });
        }

        if (req.method === 'DELETE') {
          const authorization = String(req.headers.authorization || '');
          const key = authorization.startsWith('Bearer ')
            ? authorization.slice(7).trim()
            : '';
          if (!key || !store.verifyHost(room, key)) {
            throw new HttpError(403, 'HOST_KEY_INVALID', '房主凭证无效');
          }
          store.close(room.id);
          hub.closeRoom(room.id, '房主关闭了房间');
          return sendJson(res, 200, { ok: true });
        }

        throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法', {
          Allow: 'GET, DELETE',
        });
      }

      if (pathname === '/vendor/hls.min.js' && req.method === 'GET') {
        return serveHls(req, res);
      }

      const inviteMatch = pathname.match(/^\/r\/([^/]+)\/?$/);
      if (inviteMatch) {
        let decodedInvite;
        try {
          decodedInvite = decodeURIComponent(inviteMatch[1]);
        } catch {
          throw new HttpError(404, 'ROOM_NOT_FOUND', '邀请链接无效');
        }
        const roomId = normalizeRoomId(decodedInvite);
        if (!roomId) throw new HttpError(404, 'ROOM_NOT_FOUND', '邀请链接无效');
        res.writeHead(302, {
          Location: `/?room=${encodeURIComponent(roomId)}`,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法', {
          Allow: 'GET, HEAD',
        });
      }

      return await serveStatic(req, res, pathname, publicDir);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(
        res,
        error instanceof HttpError
          ? error
          : new HttpError(500, 'INTERNAL_ERROR', '服务器内部错误'),
        requestId,
      );
    } finally {
      if (config.logRequests) {
        res.once('finish', () => {
          console.log(
            `[http] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`,
          );
        });
      }
    }
  };
}
