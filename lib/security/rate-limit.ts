import { createApiError } from "@/lib/errors";
import { env } from "@/lib/config/env";
import { API_ERROR_CODES, type ApiError } from "@/lib/types";

export type RateLimitBucket = "extract" | "download" | "job-status" | "job-cancel" | "file" | "default";
export type RateLimitScope = RateLimitBucket;

export type RateLimitConfig = {
  bucket: RateLimitBucket;
  windowSeconds: number;
  maxRequests: number;
  maxTrackedKeys: number;
};

export type RateLimitPolicy = RateLimitConfig;

export type RateLimitKeyInput = {
  bucket?: RateLimitBucket;
  identifier?: string;
  headers?: Headers;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type RateLimitAllowed = {
  ok: true;
  allowed: true;
  bucket: RateLimitBucket;
  key: string;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: 0;
};

export type RateLimitRejected = {
  ok: false;
  allowed: false;
  bucket: RateLimitBucket;
  key: string;
  limit: number;
  remaining: 0;
  resetAt: number;
  retryAfterSeconds: number;
  error: ApiError;
  code: ApiError["code"];
  message: string;
};

export type RateLimitResult = RateLimitAllowed | RateLimitRejected;

const store = new Map<string, RateLimitEntry>();
const DEFAULT_MAX_TRACKED_KEYS = 10_000;

function sanitizeIdentifier(value: string): string {
  return value.slice(0, 128).replace(/[^a-zA-Z0-9:._,-]/g, "");
}

export function getClientIpFromHeaders(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = headers.get("x-real-ip")?.trim();
  const cfConnectingIp = headers.get("cf-connecting-ip")?.trim();
  return sanitizeIdentifier(forwardedFor || realIp || cfConnectingIp || "anonymous") || "anonymous";
}

export function getRateLimitConfig(bucket: RateLimitBucket = "default"): RateLimitConfig {
  const globalMaxRequests = env.rateLimitMaxRequests;
  const downloadMaxRequests = globalMaxRequests === 0 ? 0 : Math.min(globalMaxRequests, 10);
  const jobStatusMaxRequests = globalMaxRequests === 0 ? 0 : Math.max(globalMaxRequests, 120);
  const jobCancelMaxRequests = globalMaxRequests === 0 ? 0 : Math.min(globalMaxRequests, 20);
  const fileMaxRequests = globalMaxRequests === 0 ? 0 : Math.max(globalMaxRequests, 120);

  const bucketDefaults: Record<RateLimitBucket, { maxRequests: number }> = {
    extract: { maxRequests: globalMaxRequests },
    download: { maxRequests: downloadMaxRequests },
    "job-status": { maxRequests: jobStatusMaxRequests },
    "job-cancel": { maxRequests: jobCancelMaxRequests },
    file: { maxRequests: fileMaxRequests },
    default: { maxRequests: globalMaxRequests }
  };

  return {
    bucket,
    windowSeconds: Math.max(1, env.rateLimitWindowSeconds),
    maxRequests: bucketDefaults[bucket].maxRequests,
    maxTrackedKeys: DEFAULT_MAX_TRACKED_KEYS
  };
}

export function createRateLimitKey(input: RateLimitKeyInput): string {
  const bucket = input.bucket ?? "default";
  const identifier = input.identifier ?? (input.headers ? getClientIpFromHeaders(input.headers) : "anonymous");
  return `${bucket}:${sanitizeIdentifier(identifier) || "anonymous"}`;
}

function evictExpiredEntries(now: number) {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

function createRejectedResult(config: RateLimitConfig, key: string, resetAt: number, retryAfterSeconds: number): RateLimitRejected {
  const error = createApiError(API_ERROR_CODES.RATE_LIMITED, "Слишком много запросов. Повторите попытку позже.", {
    bucket: config.bucket,
    retryAfterSeconds
  });

  return {
    ok: false,
    allowed: false,
    bucket: config.bucket,
    key,
    limit: config.maxRequests,
    remaining: 0,
    resetAt,
    retryAfterSeconds,
    error,
    code: error.code,
    message: error.message
  };
}

// Dev/single-process fallback. TODO: move production rate limiting to Redis/Upstash.
export function checkRateLimit(input: RateLimitKeyInput, overrideConfig: Partial<RateLimitConfig> = {}): RateLimitResult {
  const bucket = input.bucket ?? "default";
  const baseConfig = getRateLimitConfig(bucket);
  const config: RateLimitConfig = { ...baseConfig, ...overrideConfig, bucket };
  const key = createRateLimitKey({ ...input, bucket });
  const now = Date.now();
  const windowMs = Math.max(1, config.windowSeconds) * 1000;

  if (config.maxRequests === 0) {
    return {
      ok: true,
      allowed: true,
      bucket,
      key,
      limit: 0,
      remaining: Number.MAX_SAFE_INTEGER,
      resetAt: now + windowMs,
      retryAfterSeconds: 0
    };
  }

  if (store.size >= config.maxTrackedKeys) evictExpiredEntries(now);

  if (store.size >= config.maxTrackedKeys && !store.has(key)) {
    return createRejectedResult(config, key, now + windowMs, Math.ceil(windowMs / 1000));
  }

  const current = store.get(key);
  if (!current || current.resetAt <= now) {
    const resetAt = now + windowMs;
    store.set(key, { count: 1, resetAt });
    return {
      ok: true,
      allowed: true,
      bucket,
      key,
      limit: config.maxRequests,
      remaining: Math.max(0, config.maxRequests - 1),
      resetAt,
      retryAfterSeconds: 0
    };
  }

  current.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));

  if (current.count > config.maxRequests) {
    return createRejectedResult(config, key, current.resetAt, retryAfterSeconds);
  }

  return {
    ok: true,
    allowed: true,
    bucket,
    key,
    limit: config.maxRequests,
    remaining: Math.max(0, config.maxRequests - current.count),
    resetAt: current.resetAt,
    retryAfterSeconds: 0
  };
}

export function resetRateLimitStoreForTests() {
  store.clear();
}

export function consumeScopedRateLimit(bucket: RateLimitBucket, identifier: string, overrideConfig?: Partial<RateLimitConfig>): RateLimitResult {
  return checkRateLimit({ bucket, identifier }, overrideConfig);
}

export function consumeRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const result = checkRateLimit({ bucket: "default", identifier: key });
  return {
    allowed: result.allowed,
    retryAfterSeconds: result.retryAfterSeconds
  };
}

export const resetInMemoryRateLimits = resetRateLimitStoreForTests;
