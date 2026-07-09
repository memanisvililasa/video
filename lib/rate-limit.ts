type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const requests = new Map<string, RateLimitEntry>();
const WINDOW_MS = Math.max(1, Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? "60")) * 1000;
const MAX_REQUESTS = Math.max(0, Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? "1000"));
const MAX_TRACKED_CLIENTS = 10_000;

function evictExpiredEntries(now: number) {
  for (const [key, entry] of requests) {
    if (entry.resetAt <= now) requests.delete(key);
  }
}

/** In-memory limiter suitable for one process. Use Vercel KV/Upstash in multi-instance production. */
export function consumeRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  if (MAX_REQUESTS === 0) return { allowed: true, retryAfterSeconds: 0 };

  const now = Date.now();
  if (requests.size >= MAX_TRACKED_CLIENTS) evictExpiredEntries(now);
  // A bounded in-process fallback prevents unbounded memory use during a flood.
  if (requests.size >= MAX_TRACKED_CLIENTS && !requests.has(key)) {
    return { allowed: false, retryAfterSeconds: 60 };
  }
  const current = requests.get(key);

  if (!current || current.resetAt <= now) {
    requests.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  current.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  return { allowed: current.count <= MAX_REQUESTS, retryAfterSeconds };
}
