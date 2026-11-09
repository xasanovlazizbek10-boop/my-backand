'use strict';

/**
 * Small in-memory fixed-window rate limiter.
 * Keyed by "<bucket>:<ip>". Good enough for a single process; swap for Redis
 * if the API is ever scaled horizontally.
 */
class RateLimiter {
  constructor({ windowMs, max, cleanupMs = 60_000 }) {
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map();
    this.timer = setInterval(() => this.cleanup(), cleanupMs);
    this.timer.unref?.();
  }

  cleanup(now = Date.now()) {
    for (const [key, entry] of this.buckets) {
      if (now >= entry.resetAt) this.buckets.delete(key);
    }
  }

  /**
   * @returns {{allowed: boolean, remaining: number, resetAt: number, retryAfterMs: number}}
   */
  hit(key, max = this.max, now = Date.now()) {
    let entry = this.buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, entry);
    }

    entry.count += 1;
    const allowed = entry.count <= max;
    return {
      allowed,
      remaining: Math.max(0, max - entry.count),
      resetAt: entry.resetAt,
      retryAfterMs: entry.resetAt - now,
    };
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { RateLimiter };
