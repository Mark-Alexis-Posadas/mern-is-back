import type { RequestHandler } from "express";

interface RateLimitOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

export const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
export const REGISTRATION_RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 };

// Process-local fixed windows. All attempts count, including successful and
// malformed requests. A shared store/gateway is required across server instances.
export function createAuthRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
  now = Date.now,
}: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;
  return (req, res, next) => {
    const time = now();
    if (time >= nextSweep) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= time) buckets.delete(key);
      }
      nextSweep = time + 60_000;
    }
    // Express has trust proxy disabled in this app. Never read X-Forwarded-For
    // directly; deployment must explicitly configure trusted proxies if needed.
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let bucket = buckets.get(key);
    if (bucket && bucket.resetAt <= time) {
      buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket && buckets.size < maxKeys) {
      bucket = { count: 0, resetAt: time + windowMs };
      buckets.set(key, bucket);
    }
    // Fail closed at the memory cap rather than evicting active limits.
    if (!bucket || bucket.count >= limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((bucket?.resetAt ?? time + windowMs) - time) / 1000),
      );
      res.setHeader("Retry-After", retryAfter);
      res.setHeader("Cache-Control", "no-store");
      res.status(429).json({
        message: "Too many authentication attempts. Please try again later.",
      });
      return;
    }
    bucket.count++;
    next();
  };
}
