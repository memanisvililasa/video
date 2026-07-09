export {
  checkRateLimit,
  consumeRateLimit,
  consumeScopedRateLimit,
  createRateLimitKey,
  getClientIpFromHeaders,
  getRateLimitConfig,
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
