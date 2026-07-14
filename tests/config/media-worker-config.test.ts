import { describe, expect, it } from "vitest";
import { parseMediaWorkerConfig } from "@/lib/config/env";
import { createJobWorkerId, isSafeJobWorkerId } from "@/lib/jobs/job-lease-queue";

function workerEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_PROCESS_ROLE: "worker",
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: "postgresql://worker:secret@db.example.test/videosave",
    POSTGRES_POOL_MAX: "4",
    MEDIA_STORAGE_BACKEND: "durable-volume",
    MEDIA_STORAGE_ROOT: "/srv/videosave-media",
    MEDIA_STORAGE_AUTHORITY_ID: "0123456789abcdef0123456789abcdef",
    WORKER_CONCURRENCY: "2",
    NODE_ENV: "test",
    ...overrides
  };
}

describe("media worker configuration", () => {
  it("parses the explicit PostgreSQL/durable worker boundary", () => {
    const config = parseMediaWorkerConfig(workerEnvironment());
    expect(config.role).toBe("worker");
    expect(config.workerConcurrency).toBe(2);
    expect(config.repository.backend).toBe("postgres");
    expect(config.storage).toMatchObject({ backend: "durable-volume", root: "/srv/videosave-media" });
    expect(config).toMatchObject({
      recoveryEnabled: true,
      dbLossGraceMs: 5_000,
      cancellationPollIntervalMs: 2_000,
      reconciliationIntervalMs: 60_000,
      expirationBatchSize: 100
    });
  });

  it.each([
    { APP_PROCESS_ROLE: "web" },
    { JOB_REPOSITORY_BACKEND: "memory" },
    { MEDIA_STORAGE_BACKEND: "local" },
    { WORKER_CONCURRENCY: "0" },
    { WORKER_POLL_INTERVAL_MS: "0" },
    { POSTGRES_POOL_MAX: "3" },
    { WORKER_ID_PREFIX: "../worker" },
    { WORKER_CONCURRENCY: "2", JOB_WORKER_CONCURRENCY: "2" },
    { JOB_RECOVERY_ENABLED: "yes" },
    { WORKER_DB_LOSS_GRACE_MS: "30001" },
    { WORKER_CANCELLATION_POLL_INTERVAL_MS: "16000" },
    { JOB_RETRY_BACKOFF_BASE_MS: "10000", JOB_RETRY_BACKOFF_MAX_MS: "5000" }
  ])("fails closed for invalid worker config %#", (override) => {
    expect(() => parseMediaWorkerConfig(workerEnvironment(override))).toThrow();
  });

  it("requires absolute production media executable paths", () => {
    expect(() => parseMediaWorkerConfig(workerEnvironment({ NODE_ENV: "production" }))).toThrow(/absolute path/);
  });

  it("uses a configured namespace while preserving the database worker-id shape", () => {
    const workerId = createJobWorkerId("phase-a");
    expect(isSafeJobWorkerId(workerId)).toBe(true);
    expect(workerId).toMatch(/^worker_[a-f0-9]{32}$/);
  });
});
