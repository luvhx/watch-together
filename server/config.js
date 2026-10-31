/**
 * 应用配置全部来自环境变量，并提供适合单机自托管的安全默认值。
 * 显式传入 `env` 便于测试，不依赖进程级全局状态。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function numberFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function integerFromEnv(env, name, fallback, min, max) {
  const value = Math.trunc(numberFromEnv(env, name, fallback));
  return Math.min(max, Math.max(min, value));
}

function booleanFromEnv(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    host: env.HOST || '0.0.0.0',
    port: integerFromEnv(env, 'PORT', 8364, 1, 65_535),
    roomTtlMs: integerFromEnv(env, 'ROOM_TTL_HOURS', 12, 1, 168) * HOUR,
    emptyRoomTtlMs:
      integerFromEnv(env, 'EMPTY_ROOM_TTL_MINUTES', 120, 1, 10_080) * MINUTE,
    maxMembers: integerFromEnv(env, 'MAX_MEMBERS', 20, 2, 100),
    maxRooms: integerFromEnv(env, 'MAX_ROOMS', 500, 1, 10_000),
    trustProxy: booleanFromEnv(env, 'TRUST_PROXY'),
    syncIntervalMs: integerFromEnv(env, 'SYNC_INTERVAL_MS', 2_500, 500, 30_000),
    hostTimeoutMs: integerFromEnv(env, 'HOST_TIMEOUT_MS', 8_000, 1_000, 60_000),
    createLimitPer10Min: integerFromEnv(env, 'CREATE_LIMIT_PER_10MIN', 20, 1, 1_000),
    wsLimitPerMin: integerFromEnv(env, 'WS_LIMIT_PER_MIN', 90, 1, 10_000),
    logRequests: booleanFromEnv(env, 'LOG_REQUESTS', false),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    // 自托管媒体库常在局域网/本机/Tailscale/fake-IP 上；公网实例可设为 0 收紧。
    allowPrivateMedia: booleanFromEnv(env, 'ALLOW_PRIVATE_MEDIA', true),
  });
}
