function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export type TrustProxyMode = "none";

export type RateLimitSecurityConfig = Readonly<{
  trustProxyMode: TrustProxyMode;
  rateLimitWindowSeconds: number;
  rateLimitMaxRequests: number;
}>;

export const RATE_LIMIT_CONFIG_LIMITS = Object.freeze({
  maxWindowSeconds: 86_400,
  maxRequests: 10_000
});

function parseTrustProxyMode(value: string | undefined): TrustProxyMode {
  const normalized = value?.trim();
  if (!normalized || normalized === "none") return "none";
  throw new TypeError("TRUST_PROXY_MODE must be exactly 'none'.");
}

function parseBoundedPositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum: number
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new TypeError(`${name} exceeds its supported range.`);
  }
  return parsed;
}

export function parseRateLimitSecurityConfig(
  source: Readonly<Record<string, string | undefined>>
): RateLimitSecurityConfig {
  return Object.freeze({
    trustProxyMode: parseTrustProxyMode(source.TRUST_PROXY_MODE),
    rateLimitWindowSeconds: parseBoundedPositiveInteger(
      "RATE_LIMIT_WINDOW_SECONDS",
      source.RATE_LIMIT_WINDOW_SECONDS,
      60,
      RATE_LIMIT_CONFIG_LIMITS.maxWindowSeconds
    ),
    rateLimitMaxRequests: parseBoundedPositiveInteger(
      "RATE_LIMIT_MAX_REQUESTS",
      source.RATE_LIMIT_MAX_REQUESTS,
      30,
      RATE_LIMIT_CONFIG_LIMITS.maxRequests
    )
  });
}

const rateLimitSecurityConfig = parseRateLimitSecurityConfig(process.env);

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  maxFileSizeMb: numberFromEnv("MAX_FILE_SIZE_MB", 500),
  maxVideoDurationMinutes: numberFromEnv("MAX_VIDEO_DURATION_MINUTES", 30),
  tempFileTtlMinutes: numberFromEnv("TEMP_FILE_TTL_MINUTES", 60),
  trustProxyMode: rateLimitSecurityConfig.trustProxyMode,
  rateLimitWindowSeconds: rateLimitSecurityConfig.rateLimitWindowSeconds,
  rateLimitMaxRequests: rateLimitSecurityConfig.rateLimitMaxRequests,
  storagePath: process.env.STORAGE_PATH || "./storage/tmp",
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
  downloadTimeoutSeconds: numberFromEnv("DOWNLOAD_TIMEOUT_SECONDS", 120),
  ffprobeTimeoutSeconds: positiveIntegerFromEnv("FFPROBE_TIMEOUT_SECONDS", 15),
  ffmpegTimeoutSeconds: positiveIntegerFromEnv("FFMPEG_TIMEOUT_SECONDS", 900),
  ffmpegKillGraceSeconds: positiveIntegerFromEnv("FFMPEG_KILL_GRACE_SECONDS", 2),
  ffmpegThreads: positiveIntegerFromEnv("FFMPEG_THREADS", 2),
  maxConcurrentJobs: numberFromEnv("MAX_CONCURRENT_JOBS", 2),
  maxQueuedJobs: numberFromEnv("MAX_QUEUED_JOBS", 100),
  redisUrl: process.env.REDIS_URL || "",
  nodeEnv: process.env.NODE_ENV || "development"
} as const;
