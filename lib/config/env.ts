function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const env = {
  maxFileSizeMb: numberFromEnv("MAX_FILE_SIZE_MB", 500),
  maxVideoDurationMinutes: numberFromEnv("MAX_VIDEO_DURATION_MINUTES", 30),
  tempFileTtlMinutes: numberFromEnv("TEMP_FILE_TTL_MINUTES", 60),
  rateLimitWindowSeconds: numberFromEnv("RATE_LIMIT_WINDOW_SECONDS", 60),
  rateLimitMaxRequests: numberFromEnv("RATE_LIMIT_MAX_REQUESTS", 30),
  storagePath: process.env.STORAGE_PATH || "./storage/tmp",
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
  downloadTimeoutSeconds: numberFromEnv("DOWNLOAD_TIMEOUT_SECONDS", 120),
  ffmpegTimeoutSeconds: numberFromEnv("FFMPEG_TIMEOUT_SECONDS", 300),
  maxConcurrentJobs: numberFromEnv("MAX_CONCURRENT_JOBS", 2),
  redisUrl: process.env.REDIS_URL || "",
  nodeEnv: process.env.NODE_ENV || "development"
} as const;
