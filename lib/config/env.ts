import path from "node:path";

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export type TrustProxyMode = "none" | "nginx-single-host";

export type ApplicationProcessRole = "local" | "web" | "worker" | "migration";

export type JobRepositoryBackend = "memory" | "postgres";

export type PostgresSslMode = "disable" | "require";

export type PostgresConnectionConfig = Readonly<{
  databaseUrl: string;
  sslMode: PostgresSslMode;
  poolMax: number;
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  idleTimeoutMs: number;
}>;

export type JobRepositoryConfig =
  | Readonly<{ backend: "memory" }>
  | Readonly<{ backend: "postgres"; postgres: PostgresConnectionConfig }>;

export type JobQueueConfig = Readonly<{
  workerConcurrency: number;
  leaseDurationMs: number;
  leaseRenewIntervalMs: number;
  recoveryIntervalMs: number;
  recoveryBatchSize: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  activeTtlSeconds: number;
  maxRetries: number;
}>;

export type MediaStorageBackend = "local" | "durable-volume";

export type MediaStorageConfig = Readonly<{
  backend: MediaStorageBackend;
  root: string | null;
  authorityId: string | null;
  maxJobBytes: number;
  maxOutputBytes: number;
  finalTtlSeconds: number;
  lowDiskBytes: number;
  cleanupBatchSize: number;
}>;

export type MediaWorkerConfig = Readonly<{
  role: "worker";
  workerIdPrefix: string;
  workerConcurrency: number;
  pollIntervalMs: number;
  progressIntervalMs: number;
  shutdownGraceMs: number;
  attemptTimeoutMs: number;
  metadataTimeoutSeconds: number;
  downloadTimeoutSeconds: number;
  ffprobeTimeoutSeconds: number;
  ffmpegTimeoutSeconds: number;
  ffmpegKillGraceSeconds: number;
  ffmpegThreads: number;
  ffmpegPath: string;
  ffprobePath: string;
  maxFileSizeBytes: number;
  maxDurationSeconds: number;
  recoveryEnabled: boolean;
  dbLossGraceMs: number;
  cancellationPollIntervalMs: number;
  reconciliationIntervalMs: number;
  orphanGraceMs: number;
  expirationBatchSize: number;
  electionRetryIntervalMs: number;
  storageHealthIntervalMs: number;
  expiredRetentionSeconds: number;
  queue: JobQueueConfig;
  repository: Extract<JobRepositoryConfig, { backend: "postgres" }>;
  storage: MediaStorageConfig & Readonly<{
    backend: "durable-volume";
    root: string;
    authorityId: string;
  }>;
}>;

export type ProductionWebConfig = Readonly<{
  role: "web";
  repository: Extract<JobRepositoryConfig, { backend: "postgres" }>;
  queue: Readonly<{ activeTtlSeconds: number }>;
  storage: MediaStorageConfig & Readonly<{
    backend: "durable-volume";
    root: string;
    authorityId: string;
  }>;
}>;

export type RateLimitSecurityConfig = Readonly<{
  trustProxyMode: TrustProxyMode;
  rateLimitWindowSeconds: number;
  rateLimitMaxRequests: number;
}>;

export const RATE_LIMIT_CONFIG_LIMITS = Object.freeze({
  maxWindowSeconds: 86_400,
  maxRequests: 10_000
});

export const POSTGRES_CONFIG_LIMITS = Object.freeze({
  poolMax: Object.freeze({ min: 1, max: 20, default: 5 }),
  connectionTimeoutMs: Object.freeze({ min: 100, max: 30_000, default: 5_000 }),
  statementTimeoutMs: Object.freeze({ min: 100, max: 120_000, default: 15_000 }),
  queryTimeoutMs: Object.freeze({ min: 100, max: 120_000, default: 15_000 }),
  idleTimeoutMs: Object.freeze({ min: 1_000, max: 300_000, default: 30_000 })
});

export const JOB_QUEUE_CONFIG_LIMITS = Object.freeze({
  workerConcurrency: Object.freeze({ min: 1, max: 8, default: 2 }),
  leaseDurationMs: Object.freeze({ min: 15_000, max: 300_000, default: 60_000 }),
  leaseRenewIntervalMs: Object.freeze({ min: 1_000, max: 60_000, default: 15_000 }),
  recoveryIntervalMs: Object.freeze({ min: 5_000, max: 60_000, default: 15_000 }),
  recoveryBatchSize: Object.freeze({ min: 1, max: 1_000, default: 100 }),
  retryBackoffBaseMs: Object.freeze({ min: 1_000, max: 300_000, default: 5_000 }),
  retryBackoffMaxMs: Object.freeze({ min: 1_000, max: 3_600_000, default: 300_000 }),
  activeTtlSeconds: Object.freeze({ min: 300, max: 604_800, default: 86_400 }),
  maxRetries: Object.freeze({ min: 0, max: 10, default: 3 })
});

export const MEDIA_STORAGE_CONFIG_LIMITS = Object.freeze({
  maxOutputBytes: Object.freeze({ min: 1_048_576, max: 10_737_418_240, default: 524_288_000 }),
  maxJobBytes: Object.freeze({ min: 2_097_152, max: 21_474_836_480, default: 1_073_741_824 }),
  finalTtlSeconds: Object.freeze({ min: 60, max: 604_800, default: 3_600 }),
  lowDiskBytes: Object.freeze({ min: 1_048_576, max: 1_099_511_627_776, default: 1_073_741_824 }),
  cleanupBatchSize: Object.freeze({ min: 1, max: 1_000, default: 100 })
});

const DURABLE_VOLUME_AUTHORITY_ID = /^[a-f0-9]{32}$/;

export const MEDIA_WORKER_CONFIG_LIMITS = Object.freeze({
  concurrency: Object.freeze({ min: 1, max: 8, default: 2 }),
  pollIntervalMs: Object.freeze({ min: 100, max: 5_000, default: 1_000 }),
  progressIntervalMs: Object.freeze({ min: 250, max: 5_000, default: 1_000 }),
  shutdownGraceMs: Object.freeze({ min: 1_000, max: 300_000, default: 30_000 }),
  attemptTimeoutMs: Object.freeze({ min: 60_000, max: 3_600_000, default: 1_200_000 }),
  metadataTimeoutSeconds: Object.freeze({ min: 1, max: 120, default: 10 }),
  downloadTimeoutSeconds: Object.freeze({ min: 1, max: 900, default: 120 }),
  ffprobeTimeoutSeconds: Object.freeze({ min: 1, max: 120, default: 15 }),
  ffmpegTimeoutSeconds: Object.freeze({ min: 1, max: 3_600, default: 900 }),
  ffmpegKillGraceSeconds: Object.freeze({ min: 1, max: 30, default: 2 }),
  ffmpegThreads: Object.freeze({ min: 1, max: 8, default: 2 }),
  maxFileSizeMb: Object.freeze({ min: 1, max: 10_240, default: 500 }),
  maxDurationMinutes: Object.freeze({ min: 1, max: 1_440, default: 30 }),
  dbLossGraceMs: Object.freeze({ min: 0, max: 30_000, default: 5_000 }),
  cancellationPollIntervalMs: Object.freeze({ min: 250, max: 15_000, default: 2_000 }),
  reconciliationIntervalMs: Object.freeze({ min: 5_000, max: 3_600_000, default: 60_000 }),
  orphanGraceMs: Object.freeze({ min: 1_000, max: 86_400_000, default: 60_000 }),
  expirationBatchSize: Object.freeze({ min: 1, max: 1_000, default: 100 }),
  electionRetryIntervalMs: Object.freeze({ min: 1_000, max: 60_000, default: 5_000 }),
  storageHealthIntervalMs: Object.freeze({ min: 1_000, max: 60_000, default: 5_000 }),
  expiredRetentionSeconds: Object.freeze({ min: 60, max: 604_800, default: 86_400 })
});

function parseTrustProxyMode(value: string | undefined): TrustProxyMode {
  const normalized = value?.trim();
  if (!normalized || normalized === "none") return "none";
  if (normalized === "nginx-single-host") return normalized;
  throw new TypeError("TRUST_PROXY_MODE must be exactly 'none' or 'nginx-single-host'.");
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

function parseBoundedInteger(
  name: string,
  value: string | undefined,
  limits: Readonly<{ min: number; max: number; default: number }>
): number {
  const normalized = value?.trim();
  if (!normalized) return limits.default;
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new TypeError(`${name} must be a positive integer.`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < limits.min || parsed > limits.max) {
    throw new TypeError(`${name} must be between ${limits.min} and ${limits.max}.`);
  }
  return parsed;
}

function parseBoundedNonNegativeInteger(
  name: string,
  value: string | undefined,
  limits: Readonly<{ min: number; max: number; default: number }>
): number {
  const normalized = value?.trim();
  if (!normalized) return limits.default;
  if (!/^\d+$/.test(normalized)) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < limits.min || parsed > limits.max) {
    throw new TypeError(`${name} must be between ${limits.min} and ${limits.max}.`);
  }
  return parsed;
}

function parseStrictBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new TypeError(`${name} must be exactly 'true' or 'false'.`);
}

/**
 * Application roles are resolved only at an explicit server/runtime boundary.
 * A missing non-production role keeps local development convenient; production
 * never silently selects the process-local runtime.
 */
export function parseApplicationProcessRole(
  source: Readonly<Record<string, string | undefined>>
): ApplicationProcessRole {
  const production = source.NODE_ENV?.trim() === "production";
  const configured = source.APP_PROCESS_ROLE?.trim();
  if (!configured) {
    if (production) throw new TypeError("APP_PROCESS_ROLE is required in production.");
    return "local";
  }
  if (
    configured !== "local" &&
    configured !== "web" &&
    configured !== "worker" &&
    configured !== "migration"
  ) {
    throw new TypeError("APP_PROCESS_ROLE must be exactly 'local', 'web', 'worker', or 'migration'.");
  }
  if (production && configured === "local") {
    throw new TypeError("APP_PROCESS_ROLE=local is not permitted in production.");
  }
  return configured;
}

function parseDatabaseUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new TypeError("DATABASE_URL is required when JOB_REPOSITORY_BACKEND=postgres.");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TypeError("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new TypeError("DATABASE_URL must include a host and database name.");
  }

  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith("ssl")) {
      throw new TypeError(
        "DATABASE_URL must not override TLS parameters; use POSTGRES_SSL_MODE."
      );
    }
  }
  return normalized;
}

function parsePostgresSslMode(
  value: string | undefined,
  nodeEnv: string | undefined
): PostgresSslMode {
  const production = nodeEnv?.trim() === "production";
  const normalized = value?.trim() || (production ? "require" : "disable");
  if (normalized !== "disable" && normalized !== "require") {
    throw new TypeError("POSTGRES_SSL_MODE must be exactly 'disable' or 'require'.");
  }
  if (production && normalized !== "require") {
    throw new TypeError("Production PostgreSQL connections require verified TLS.");
  }
  return normalized;
}

/**
 * Explicit persistence boundary. This parser is intentionally not used by the
 * current API composition root, which remains in-memory until a later cutover.
 */
export function parseJobRepositoryConfig(
  source: Readonly<Record<string, string | undefined>>
): JobRepositoryConfig {
  const backend = source.JOB_REPOSITORY_BACKEND?.trim() || "memory";
  if (backend === "memory") return Object.freeze({ backend });
  if (backend !== "postgres") {
    throw new TypeError("JOB_REPOSITORY_BACKEND must be exactly 'memory' or 'postgres'.");
  }

  return Object.freeze({
    backend,
    postgres: Object.freeze({
      databaseUrl: parseDatabaseUrl(source.DATABASE_URL),
      sslMode: parsePostgresSslMode(source.POSTGRES_SSL_MODE, source.NODE_ENV),
      poolMax: parseBoundedInteger(
        "POSTGRES_POOL_MAX",
        source.POSTGRES_POOL_MAX,
        POSTGRES_CONFIG_LIMITS.poolMax
      ),
      connectionTimeoutMs: parseBoundedInteger(
        "POSTGRES_CONNECTION_TIMEOUT_MS",
        source.POSTGRES_CONNECTION_TIMEOUT_MS,
        POSTGRES_CONFIG_LIMITS.connectionTimeoutMs
      ),
      statementTimeoutMs: parseBoundedInteger(
        "POSTGRES_STATEMENT_TIMEOUT_MS",
        source.POSTGRES_STATEMENT_TIMEOUT_MS,
        POSTGRES_CONFIG_LIMITS.statementTimeoutMs
      ),
      queryTimeoutMs: parseBoundedInteger(
        "POSTGRES_QUERY_TIMEOUT_MS",
        source.POSTGRES_QUERY_TIMEOUT_MS,
        POSTGRES_CONFIG_LIMITS.queryTimeoutMs
      ),
      idleTimeoutMs: parseBoundedInteger(
        "POSTGRES_IDLE_TIMEOUT_MS",
        source.POSTGRES_IDLE_TIMEOUT_MS,
        POSTGRES_CONFIG_LIMITS.idleTimeoutMs
      )
    })
  });
}

/** Parsed only by the explicit PostgreSQL queue/worker construction boundary. */
export function parseJobQueueConfig(
  source: Readonly<Record<string, string | undefined>>
): JobQueueConfig {
  const config: JobQueueConfig = Object.freeze({
    workerConcurrency: parseBoundedInteger(
      "JOB_WORKER_CONCURRENCY",
      source.JOB_WORKER_CONCURRENCY,
      JOB_QUEUE_CONFIG_LIMITS.workerConcurrency
    ),
    leaseDurationMs: parseBoundedInteger(
      "JOB_LEASE_DURATION_MS",
      source.JOB_LEASE_DURATION_MS,
      JOB_QUEUE_CONFIG_LIMITS.leaseDurationMs
    ),
    leaseRenewIntervalMs: parseBoundedInteger(
      "JOB_LEASE_RENEW_INTERVAL_MS",
      source.JOB_LEASE_RENEW_INTERVAL_MS,
      JOB_QUEUE_CONFIG_LIMITS.leaseRenewIntervalMs
    ),
    recoveryIntervalMs: parseBoundedInteger(
      "JOB_RECOVERY_INTERVAL_MS",
      source.JOB_RECOVERY_INTERVAL_MS,
      JOB_QUEUE_CONFIG_LIMITS.recoveryIntervalMs
    ),
    recoveryBatchSize: parseBoundedInteger(
      "JOB_RECOVERY_BATCH_SIZE",
      source.JOB_RECOVERY_BATCH_SIZE,
      JOB_QUEUE_CONFIG_LIMITS.recoveryBatchSize
    ),
    retryBackoffBaseMs: parseBoundedInteger(
      "JOB_RETRY_BACKOFF_BASE_MS",
      source.JOB_RETRY_BACKOFF_BASE_MS,
      JOB_QUEUE_CONFIG_LIMITS.retryBackoffBaseMs
    ),
    retryBackoffMaxMs: parseBoundedInteger(
      "JOB_RETRY_BACKOFF_MAX_MS",
      source.JOB_RETRY_BACKOFF_MAX_MS,
      JOB_QUEUE_CONFIG_LIMITS.retryBackoffMaxMs
    ),
    activeTtlSeconds: parseBoundedInteger(
      "JOB_ACTIVE_TTL_SECONDS",
      source.JOB_ACTIVE_TTL_SECONDS,
      JOB_QUEUE_CONFIG_LIMITS.activeTtlSeconds
    ),
    maxRetries: parseBoundedNonNegativeInteger(
      "JOB_MAX_RETRIES",
      source.JOB_MAX_RETRIES,
      JOB_QUEUE_CONFIG_LIMITS.maxRetries
    )
  });
  if (config.leaseRenewIntervalMs * 3 > config.leaseDurationMs) {
    throw new TypeError(
      "JOB_LEASE_RENEW_INTERVAL_MS must be at most one third of JOB_LEASE_DURATION_MS."
    );
  }
  if (config.recoveryIntervalMs > config.leaseDurationMs) {
    throw new TypeError(
      "JOB_RECOVERY_INTERVAL_MS must not exceed JOB_LEASE_DURATION_MS."
    );
  }
  if (config.retryBackoffMaxMs < config.retryBackoffBaseMs) {
    throw new TypeError("JOB_RETRY_BACKOFF_MAX_MS must be at least JOB_RETRY_BACKOFF_BASE_MS.");
  }
  return config;
}

/** Parsed only by the explicit durable-volume construction boundary. */
export function parseMediaStorageConfig(
  source: Readonly<Record<string, string | undefined>>
): MediaStorageConfig {
  const backend = source.MEDIA_STORAGE_BACKEND?.trim() || "local";
  if (backend !== "local" && backend !== "durable-volume") {
    throw new TypeError("MEDIA_STORAGE_BACKEND must be exactly 'local' or 'durable-volume'.");
  }

  const configuredRoot = source.MEDIA_STORAGE_ROOT?.trim();
  const configuredAuthorityId = source.MEDIA_STORAGE_AUTHORITY_ID?.trim();
  let root: string | null = null;
  let authorityId: string | null = null;
  if (backend === "durable-volume") {
    if (!configuredRoot) {
      throw new TypeError("MEDIA_STORAGE_ROOT is required for durable-volume storage.");
    }
    if (
      configuredRoot.length > 1_024 ||
      /[\u0000-\u001f\u007f]/.test(configuredRoot) ||
      !path.isAbsolute(configuredRoot)
    ) {
      throw new TypeError("MEDIA_STORAGE_ROOT must be a valid absolute path.");
    }
    root = path.normalize(configuredRoot);
    if (configuredAuthorityId) {
      if (!DURABLE_VOLUME_AUTHORITY_ID.test(configuredAuthorityId)) {
        throw new TypeError("MEDIA_STORAGE_AUTHORITY_ID must be exactly 32 lowercase hexadecimal characters.");
      }
      authorityId = configuredAuthorityId;
    }
  } else if (configuredAuthorityId) {
    throw new TypeError("MEDIA_STORAGE_AUTHORITY_ID is only valid for durable-volume storage.");
  }

  const config = Object.freeze({
    backend,
    root,
    authorityId,
    maxJobBytes: parseBoundedInteger(
      "MEDIA_STORAGE_MAX_JOB_BYTES",
      source.MEDIA_STORAGE_MAX_JOB_BYTES,
      MEDIA_STORAGE_CONFIG_LIMITS.maxJobBytes
    ),
    maxOutputBytes: parseBoundedInteger(
      "MEDIA_STORAGE_MAX_OUTPUT_BYTES",
      source.MEDIA_STORAGE_MAX_OUTPUT_BYTES,
      MEDIA_STORAGE_CONFIG_LIMITS.maxOutputBytes
    ),
    finalTtlSeconds: parseBoundedInteger(
      "MEDIA_FINAL_TTL_SECONDS",
      source.MEDIA_FINAL_TTL_SECONDS,
      MEDIA_STORAGE_CONFIG_LIMITS.finalTtlSeconds
    ),
    lowDiskBytes: parseBoundedInteger(
      "MEDIA_STORAGE_LOW_DISK_BYTES",
      source.MEDIA_STORAGE_LOW_DISK_BYTES,
      MEDIA_STORAGE_CONFIG_LIMITS.lowDiskBytes
    ),
    cleanupBatchSize: parseBoundedInteger(
      "MEDIA_CLEANUP_BATCH_SIZE",
      source.MEDIA_CLEANUP_BATCH_SIZE,
      MEDIA_STORAGE_CONFIG_LIMITS.cleanupBatchSize
    )
  } satisfies MediaStorageConfig);
  if (config.maxJobBytes < config.maxOutputBytes) {
    throw new TypeError("MEDIA_STORAGE_MAX_JOB_BYTES must be at least MEDIA_STORAGE_MAX_OUTPUT_BYTES.");
  }
  return config;
}

/** Strict construction boundary for the persistent production web runtime. */
export function parseProductionWebConfig(
  source: Readonly<Record<string, string | undefined>>
): ProductionWebConfig {
  if (parseApplicationProcessRole(source) !== "web") {
    throw new TypeError("APP_PROCESS_ROLE must be exactly 'web' for the production web runtime.");
  }
  const repository = parseJobRepositoryConfig(source);
  if (repository.backend !== "postgres") {
    throw new TypeError("The production web runtime requires JOB_REPOSITORY_BACKEND=postgres.");
  }
  const parsedStorage = parseMediaStorageConfig(source);
  if (
    parsedStorage.backend !== "durable-volume" ||
    parsedStorage.root === null ||
    parsedStorage.authorityId === null
  ) {
    throw new TypeError("The production web runtime requires MEDIA_STORAGE_BACKEND=durable-volume.");
  }
  return Object.freeze({
    role: "web" as const,
    repository,
    queue: Object.freeze({
      activeTtlSeconds: parseBoundedInteger(
        "JOB_ACTIVE_TTL_SECONDS",
        source.JOB_ACTIVE_TTL_SECONDS,
        JOB_QUEUE_CONFIG_LIMITS.activeTtlSeconds
      )
    }),
    storage: Object.freeze({
      ...parsedStorage,
      backend: "durable-volume" as const,
      root: parsedStorage.root,
      authorityId: parsedStorage.authorityId
    })
  });
}

function parseWorkerBinaryPath(
  name: "FFMPEG_PATH" | "FFPROBE_PATH",
  value: string | undefined,
  nodeEnv: string | undefined
): string {
  const fallback = name === "FFMPEG_PATH" ? "ffmpeg" : "ffprobe";
  const normalized = value?.trim() || fallback;
  if (!normalized || normalized.length > 1_024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${name} is invalid.`);
  }
  if (nodeEnv?.trim() === "production" && !path.isAbsolute(normalized)) {
    throw new TypeError(`${name} must be an absolute path in production.`);
  }
  if (!path.isAbsolute(normalized) && normalized !== fallback) {
    throw new TypeError(`${name} must be the default basename or an absolute path.`);
  }
  return normalized;
}

/** Strict, explicit construction boundary for the standalone worker only. */
export function parseMediaWorkerConfig(
  source: Readonly<Record<string, string | undefined>>
): MediaWorkerConfig {
  if (parseApplicationProcessRole(source) !== "worker") {
    throw new TypeError("APP_PROCESS_ROLE must be exactly 'worker'.");
  }
  const repository = parseJobRepositoryConfig(source);
  if (repository.backend !== "postgres") {
    throw new TypeError("The media worker requires JOB_REPOSITORY_BACKEND=postgres.");
  }
  const parsedStorage = parseMediaStorageConfig(source);
  if (
    parsedStorage.backend !== "durable-volume" ||
    parsedStorage.root === null ||
    parsedStorage.authorityId === null
  ) {
    throw new TypeError("The media worker requires MEDIA_STORAGE_BACKEND=durable-volume.");
  }
  const queueBase = parseJobQueueConfig(source);
  if (source.WORKER_CONCURRENCY?.trim() && source.JOB_WORKER_CONCURRENCY?.trim()) {
    throw new TypeError("Configure WORKER_CONCURRENCY without JOB_WORKER_CONCURRENCY for the standalone worker.");
  }
  const workerConcurrency = parseBoundedInteger(
    "WORKER_CONCURRENCY",
    source.WORKER_CONCURRENCY ?? source.JOB_WORKER_CONCURRENCY,
    MEDIA_WORKER_CONFIG_LIMITS.concurrency
  );
  const workerIdPrefix = source.WORKER_ID_PREFIX?.trim() || "worker";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(workerIdPrefix)) {
    throw new TypeError("WORKER_ID_PREFIX is invalid.");
  }
  if (repository.postgres.poolMax < workerConcurrency + 2) {
    throw new TypeError("POSTGRES_POOL_MAX must be at least WORKER_CONCURRENCY + 2.");
  }
  const maxFileSizeMb = parseBoundedInteger(
    "MAX_FILE_SIZE_MB",
    source.MAX_FILE_SIZE_MB,
    MEDIA_WORKER_CONFIG_LIMITS.maxFileSizeMb
  );
  const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes > parsedStorage.maxJobBytes) {
    throw new TypeError("MAX_FILE_SIZE_MB must fit within MEDIA_STORAGE_MAX_JOB_BYTES.");
  }
  const maxDurationMinutes = parseBoundedInteger(
    "MAX_VIDEO_DURATION_MINUTES",
    source.MAX_VIDEO_DURATION_MINUTES,
    MEDIA_WORKER_CONFIG_LIMITS.maxDurationMinutes
  );
  const attemptTimeoutMs = parseBoundedInteger(
    "WORKER_ATTEMPT_TIMEOUT_MS",
    source.WORKER_ATTEMPT_TIMEOUT_MS,
    MEDIA_WORKER_CONFIG_LIMITS.attemptTimeoutMs
  );
  const downloadTimeoutSeconds = parseBoundedInteger(
    "DOWNLOAD_TIMEOUT_SECONDS",
    source.DOWNLOAD_TIMEOUT_SECONDS,
    MEDIA_WORKER_CONFIG_LIMITS.downloadTimeoutSeconds
  );
  const ffmpegTimeoutSeconds = parseBoundedInteger(
    "FFMPEG_TIMEOUT_SECONDS",
    source.FFMPEG_TIMEOUT_SECONDS,
    MEDIA_WORKER_CONFIG_LIMITS.ffmpegTimeoutSeconds
  );
  if (attemptTimeoutMs <= Math.max(downloadTimeoutSeconds, ffmpegTimeoutSeconds) * 1_000) {
    throw new TypeError("WORKER_ATTEMPT_TIMEOUT_MS must exceed the longest processing phase timeout.");
  }

  const queue = Object.freeze({ ...queueBase, workerConcurrency });
  const storage = Object.freeze({
    ...parsedStorage,
    backend: "durable-volume" as const,
    root: parsedStorage.root,
    authorityId: parsedStorage.authorityId
  });
  const dbLossGraceMs = parseBoundedNonNegativeInteger(
    "WORKER_DB_LOSS_GRACE_MS",
    source.WORKER_DB_LOSS_GRACE_MS,
    MEDIA_WORKER_CONFIG_LIMITS.dbLossGraceMs
  );
  const cancellationPollIntervalMs = parseBoundedInteger(
    "WORKER_CANCELLATION_POLL_INTERVAL_MS",
    source.WORKER_CANCELLATION_POLL_INTERVAL_MS,
    MEDIA_WORKER_CONFIG_LIMITS.cancellationPollIntervalMs
  );
  if (cancellationPollIntervalMs > queue.leaseRenewIntervalMs) {
    throw new TypeError("WORKER_CANCELLATION_POLL_INTERVAL_MS must not exceed JOB_LEASE_RENEW_INTERVAL_MS.");
  }
  if (
    repository.postgres.queryTimeoutMs + queue.leaseRenewIntervalMs + dbLossGraceMs + 1_000
    >= queue.leaseDurationMs
  ) {
    throw new TypeError("PostgreSQL timeout, renewal interval and DB-loss grace exceed the safe lease budget.");
  }
  const recoveryEnabled = parseStrictBoolean(
    "JOB_RECOVERY_ENABLED",
    source.JOB_RECOVERY_ENABLED,
    true
  );
  if (source.NODE_ENV?.trim() === "production" && !recoveryEnabled) {
    throw new TypeError("JOB_RECOVERY_ENABLED must be true for the production worker.");
  }

  return Object.freeze({
    role: "worker" as const,
    workerIdPrefix,
    workerConcurrency,
    pollIntervalMs: parseBoundedInteger(
      "WORKER_POLL_INTERVAL_MS",
      source.WORKER_POLL_INTERVAL_MS,
      MEDIA_WORKER_CONFIG_LIMITS.pollIntervalMs
    ),
    progressIntervalMs: parseBoundedInteger(
      "WORKER_PROGRESS_INTERVAL_MS",
      source.WORKER_PROGRESS_INTERVAL_MS,
      MEDIA_WORKER_CONFIG_LIMITS.progressIntervalMs
    ),
    shutdownGraceMs: parseBoundedInteger(
      "WORKER_SHUTDOWN_GRACE_MS",
      source.WORKER_SHUTDOWN_GRACE_MS,
      MEDIA_WORKER_CONFIG_LIMITS.shutdownGraceMs
    ),
    attemptTimeoutMs,
    metadataTimeoutSeconds: parseBoundedInteger(
      "WORKER_METADATA_TIMEOUT_SECONDS",
      source.WORKER_METADATA_TIMEOUT_SECONDS,
      MEDIA_WORKER_CONFIG_LIMITS.metadataTimeoutSeconds
    ),
    downloadTimeoutSeconds,
    ffprobeTimeoutSeconds: parseBoundedInteger(
      "FFPROBE_TIMEOUT_SECONDS",
      source.FFPROBE_TIMEOUT_SECONDS,
      MEDIA_WORKER_CONFIG_LIMITS.ffprobeTimeoutSeconds
    ),
    ffmpegTimeoutSeconds,
    ffmpegKillGraceSeconds: parseBoundedInteger(
      "FFMPEG_KILL_GRACE_SECONDS",
      source.FFMPEG_KILL_GRACE_SECONDS,
      MEDIA_WORKER_CONFIG_LIMITS.ffmpegKillGraceSeconds
    ),
    ffmpegThreads: parseBoundedInteger(
      "FFMPEG_THREADS",
      source.FFMPEG_THREADS,
      MEDIA_WORKER_CONFIG_LIMITS.ffmpegThreads
    ),
    ffmpegPath: parseWorkerBinaryPath("FFMPEG_PATH", source.FFMPEG_PATH, source.NODE_ENV),
    ffprobePath: parseWorkerBinaryPath("FFPROBE_PATH", source.FFPROBE_PATH, source.NODE_ENV),
    maxFileSizeBytes,
    maxDurationSeconds: maxDurationMinutes * 60,
    recoveryEnabled,
    dbLossGraceMs,
    cancellationPollIntervalMs,
    reconciliationIntervalMs: parseBoundedInteger(
      "MEDIA_RECONCILIATION_INTERVAL_MS",
      source.MEDIA_RECONCILIATION_INTERVAL_MS,
      MEDIA_WORKER_CONFIG_LIMITS.reconciliationIntervalMs
    ),
    orphanGraceMs: parseBoundedInteger(
      "MEDIA_ORPHAN_GRACE_MS",
      source.MEDIA_ORPHAN_GRACE_MS,
      MEDIA_WORKER_CONFIG_LIMITS.orphanGraceMs
    ),
    expirationBatchSize: parseBoundedInteger(
      "JOB_EXPIRATION_BATCH_SIZE",
      source.JOB_EXPIRATION_BATCH_SIZE,
      MEDIA_WORKER_CONFIG_LIMITS.expirationBatchSize
    ),
    electionRetryIntervalMs: parseBoundedInteger(
      "WORKER_ELECTION_RETRY_INTERVAL_MS",
      source.WORKER_ELECTION_RETRY_INTERVAL_MS,
      MEDIA_WORKER_CONFIG_LIMITS.electionRetryIntervalMs
    ),
    storageHealthIntervalMs: parseBoundedInteger(
      "WORKER_STORAGE_HEALTH_INTERVAL_MS",
      source.WORKER_STORAGE_HEALTH_INTERVAL_MS,
      MEDIA_WORKER_CONFIG_LIMITS.storageHealthIntervalMs
    ),
    expiredRetentionSeconds: parseBoundedInteger(
      "JOB_EXPIRED_RETENTION_SECONDS",
      source.JOB_EXPIRED_RETENTION_SECONDS,
      MEDIA_WORKER_CONFIG_LIMITS.expiredRetentionSeconds
    ),
    queue,
    repository,
    storage
  });
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
