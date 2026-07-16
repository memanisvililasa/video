import { createApiError } from "@/lib/errors";
import { env, RATE_LIMIT_CONFIG_LIMITS } from "@/lib/config/env";
import {
  resolveRateLimitClientIdentifier,
  UNIDENTIFIED_RATE_LIMIT_CLIENT
} from "@/lib/security/client-identifier";
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

type RateLimitKeyBase = {
  bucket?: RateLimitBucket;
};

export type RateLimitKeyInput =
  | (RateLimitKeyBase & { headers: Headers; identifier?: never })
  | (RateLimitKeyBase & { identifier: string; headers?: never })
  | (RateLimitKeyBase & { headers?: undefined; identifier?: undefined });

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
const MAX_TRACKED_KEYS_LIMIT = 100_000;
const TRUSTED_IDENTIFIER = /^[a-zA-Z0-9:._,-]{1,128}$/;

function normalizeTrustedIdentifier(value: string): string {
  if (!TRUSTED_IDENTIFIER.test(value)) {
    throw new TypeError("Trusted rate-limit identifier is invalid.");
  }
  return value;
}

/** @deprecated Forwarding headers are untrusted; use resolveRateLimitClientIdentifier. */
export function getClientIpFromHeaders(headers: Headers): string {
  return resolveRateLimitClientIdentifier(headers);
}

export function getRateLimitConfig(bucket: RateLimitBucket = "default"): RateLimitConfig {
  const globalMaxRequests = env.rateLimitMaxRequests;
  const downloadMaxRequests = Math.min(globalMaxRequests, 10);
  const jobStatusMaxRequests = Math.max(globalMaxRequests, 120);
  const jobCancelMaxRequests = Math.min(globalMaxRequests, 20);
  const fileMaxRequests = Math.max(globalMaxRequests, 120);

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
  const identifier = input.identifier !== undefined
    ? normalizeTrustedIdentifier(input.identifier)
    : input.headers
      ? resolveRateLimitClientIdentifier(input.headers)
      : UNIDENTIFIED_RATE_LIMIT_CLIENT;
  return `${bucket}:${identifier}`;
}

function assertValidEffectiveConfig(config: RateLimitConfig): void {
  if (
    !Number.isSafeInteger(config.windowSeconds) ||
    config.windowSeconds < 1 ||
    config.windowSeconds > RATE_LIMIT_CONFIG_LIMITS.maxWindowSeconds
  ) {
    throw new TypeError("Rate-limit windowSeconds is invalid.");
  }
  if (
    !Number.isSafeInteger(config.maxRequests) ||
    config.maxRequests < 1 ||
    config.maxRequests > RATE_LIMIT_CONFIG_LIMITS.maxRequests
  ) {
    throw new TypeError("Rate-limit maxRequests is invalid.");
  }
  if (
    !Number.isSafeInteger(config.maxTrackedKeys) ||
    config.maxTrackedKeys < 1 ||
    config.maxTrackedKeys > MAX_TRACKED_KEYS_LIMIT
  ) {
    throw new TypeError("Rate-limit maxTrackedKeys is invalid.");
  }
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

// Process-local limiter for personal/local and controlled single-host use.
// A public multi-user distributed limiter is outside the accepted product scope.
export function checkRateLimit(input: RateLimitKeyInput, overrideConfig: Partial<RateLimitConfig> = {}): RateLimitResult {
  const bucket = input.bucket ?? "default";
  const baseConfig = getRateLimitConfig(bucket);
  const config: RateLimitConfig = { ...baseConfig, ...overrideConfig, bucket };
  assertValidEffectiveConfig(config);
  const key = input.identifier !== undefined
    ? createRateLimitKey({ bucket, identifier: input.identifier })
    : input.headers
      ? createRateLimitKey({ bucket, headers: input.headers })
      : createRateLimitKey({ bucket });
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;

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

export { resolveRateLimitClientIdentifier } from "@/lib/security/client-identifier";
