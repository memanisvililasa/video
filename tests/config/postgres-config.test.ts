import { describe, expect, it } from "vitest";
import {
  JOB_QUEUE_CONFIG_LIMITS,
  parseJobQueueConfig,
  parseJobRepositoryConfig,
  POSTGRES_CONFIG_LIMITS
} from "@/lib/config/env";

describe("PostgreSQL repository configuration", () => {
  it("defaults local and test configuration to the memory backend", () => {
    expect(parseJobRepositoryConfig({})).toEqual({ backend: "memory" });
    expect(parseJobRepositoryConfig({ NODE_ENV: "production" })).toEqual({ backend: "memory" });
  });

  it("rejects unknown backends and explicit postgres without DATABASE_URL", () => {
    expect(() => parseJobRepositoryConfig({ JOB_REPOSITORY_BACKEND: "dual" })).toThrow(
      "JOB_REPOSITORY_BACKEND"
    );
    expect(() => parseJobRepositoryConfig({ JOB_REPOSITORY_BACKEND: "postgres" })).toThrow(
      "DATABASE_URL"
    );
  });

  it("parses a bounded explicit postgres configuration without exposing its URL", () => {
    const databaseUrl = "postgresql://app:secret@database.internal/videosave";
    const parsed = parseJobRepositoryConfig({
      JOB_REPOSITORY_BACKEND: "postgres",
      DATABASE_URL: databaseUrl,
      POSTGRES_SSL_MODE: "require",
      POSTGRES_POOL_MAX: "4",
      POSTGRES_CONNECTION_TIMEOUT_MS: "1000",
      POSTGRES_STATEMENT_TIMEOUT_MS: "2000",
      POSTGRES_QUERY_TIMEOUT_MS: "3000",
      POSTGRES_IDLE_TIMEOUT_MS: "4000"
    });
    expect(parsed).toMatchObject({
      backend: "postgres",
      postgres: {
        databaseUrl,
        sslMode: "require",
        poolMax: 4,
        connectionTimeoutMs: 1000,
        statementTimeoutMs: 2000,
        queryTimeoutMs: 3000,
        idleTimeoutMs: 4000
      }
    });
    expect(() =>
      parseJobRepositoryConfig({
        JOB_REPOSITORY_BACKEND: "postgres",
        DATABASE_URL: databaseUrl,
        POSTGRES_POOL_MAX: String(POSTGRES_CONFIG_LIMITS.poolMax.max + 1)
      })
    ).toThrow("POSTGRES_POOL_MAX");
  });

  it("fails closed on production TLS disable and URL TLS overrides", () => {
    expect(() =>
      parseJobRepositoryConfig({
        JOB_REPOSITORY_BACKEND: "postgres",
        DATABASE_URL: "postgresql://app@database.internal/videosave",
        NODE_ENV: "production",
        POSTGRES_SSL_MODE: "disable"
      })
    ).toThrow("verified TLS");
    expect(() =>
      parseJobRepositoryConfig({
        JOB_REPOSITORY_BACKEND: "postgres",
        DATABASE_URL: "postgresql://app@database.internal/videosave?sslmode=disable",
        NODE_ENV: "production"
      })
    ).toThrow("must not override TLS");
  });

  it.each([
    ["POSTGRES_POOL_MAX", "0"],
    ["POSTGRES_CONNECTION_TIMEOUT_MS", "99"],
    ["POSTGRES_STATEMENT_TIMEOUT_MS", "120001"],
    ["POSTGRES_QUERY_TIMEOUT_MS", "Infinity"],
    ["POSTGRES_IDLE_TIMEOUT_MS", "999"]
  ])("rejects out-of-range %s", (name, value) => {
    expect(() =>
      parseJobRepositoryConfig({
        JOB_REPOSITORY_BACKEND: "postgres",
        DATABASE_URL: "postgresql://app@localhost/videosave",
        [name]: value
      })
    ).toThrow(name);
  });
});

describe("PostgreSQL job queue configuration", () => {
  it("parses safe defaults only when the explicit queue boundary is called", () => {
    expect(parseJobQueueConfig({})).toEqual({
      workerConcurrency: JOB_QUEUE_CONFIG_LIMITS.workerConcurrency.default,
      leaseDurationMs: JOB_QUEUE_CONFIG_LIMITS.leaseDurationMs.default,
      leaseRenewIntervalMs: JOB_QUEUE_CONFIG_LIMITS.leaseRenewIntervalMs.default,
      recoveryIntervalMs: JOB_QUEUE_CONFIG_LIMITS.recoveryIntervalMs.default,
      recoveryBatchSize: JOB_QUEUE_CONFIG_LIMITS.recoveryBatchSize.default,
      retryBackoffBaseMs: JOB_QUEUE_CONFIG_LIMITS.retryBackoffBaseMs.default,
      retryBackoffMaxMs: JOB_QUEUE_CONFIG_LIMITS.retryBackoffMaxMs.default,
      activeTtlSeconds: JOB_QUEUE_CONFIG_LIMITS.activeTtlSeconds.default,
      maxRetries: JOB_QUEUE_CONFIG_LIMITS.maxRetries.default
    });
  });

  it("accepts a bounded lease model", () => {
    expect(
      parseJobQueueConfig({
        JOB_WORKER_CONCURRENCY: "4",
        JOB_LEASE_DURATION_MS: "90000",
        JOB_LEASE_RENEW_INTERVAL_MS: "30000",
        JOB_RECOVERY_INTERVAL_MS: "20000",
        JOB_MAX_RETRIES: "0"
      })
    ).toEqual({
      workerConcurrency: 4,
      leaseDurationMs: 90_000,
      leaseRenewIntervalMs: 30_000,
      recoveryIntervalMs: 20_000,
      recoveryBatchSize: JOB_QUEUE_CONFIG_LIMITS.recoveryBatchSize.default,
      retryBackoffBaseMs: JOB_QUEUE_CONFIG_LIMITS.retryBackoffBaseMs.default,
      retryBackoffMaxMs: JOB_QUEUE_CONFIG_LIMITS.retryBackoffMaxMs.default,
      activeTtlSeconds: JOB_QUEUE_CONFIG_LIMITS.activeTtlSeconds.default,
      maxRetries: 0
    });
  });

  it.each([
    ["JOB_WORKER_CONCURRENCY", "0"],
    ["JOB_WORKER_CONCURRENCY", "9"],
    ["JOB_LEASE_DURATION_MS", "14999"],
    ["JOB_LEASE_DURATION_MS", "Infinity"],
    ["JOB_LEASE_RENEW_INTERVAL_MS", "0"],
    ["JOB_RECOVERY_INTERVAL_MS", "4000"],
    ["JOB_MAX_RETRIES", "-1"],
    ["JOB_MAX_RETRIES", "11"]
  ])("rejects invalid queue setting %s", (name, value) => {
    expect(() => parseJobQueueConfig({ [name]: value })).toThrow(name);
  });

  it("requires renewal to be safely shorter than the lease", () => {
    expect(() =>
      parseJobQueueConfig({
        JOB_LEASE_DURATION_MS: "30000",
        JOB_LEASE_RENEW_INTERVAL_MS: "15000"
      })
    ).toThrow("one third");
    expect(() =>
      parseJobQueueConfig({
        JOB_LEASE_DURATION_MS: "15000",
        JOB_LEASE_RENEW_INTERVAL_MS: "5000",
        JOB_RECOVERY_INTERVAL_MS: "20000"
      })
    ).toThrow("must not exceed");
  });
});
