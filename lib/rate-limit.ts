export {
  checkRateLimit,
  consumeRateLimit,
  consumeScopedRateLimit,
  createRateLimitKey,
  getClientIpFromHeaders,
  getRateLimitConfig,
  resolveRateLimitClientIdentifier,
  resetInMemoryRateLimits,
  resetRateLimitStoreForTests
} from "@/lib/security/rate-limit";

export type {
  RateLimitAllowed,
  RateLimitBucket,
  RateLimitConfig,
  RateLimitKeyInput,
  RateLimitPolicy,
  RateLimitRejected,
  RateLimitResult,
  RateLimitScope
} from "@/lib/security/rate-limit";
