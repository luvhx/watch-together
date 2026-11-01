/**
 * 极简固定窗口限流器。单实例部署足够；多实例部署时应换成 Redis 等共享存储。
 */
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const buckets = new Map();

  function cleanup(current) {
    if (buckets.size < 2_000) return;
    for (const [key, bucket] of buckets) {
      if (current >= bucket.resetAt) buckets.delete(key);
    }
  }

  return function consume(key) {
    const current = now();
    let bucket = buckets.get(key);
    if (!bucket || current >= bucket.resetAt) {
      bucket = { count: 0, resetAt: current + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    cleanup(current);
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterMs: Math.max(0, bucket.resetAt - current),
    };
  };
}
