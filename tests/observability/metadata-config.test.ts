import { describe, expect, it } from "vitest";
import { parseObservabilityConfig, parseWorkerObservabilityConfig } from "@/lib/config/env";
import { createProcessMetadata } from "@/lib/observability/metadata";

describe("observability configuration", () => {
  it("uses safe local defaults and strict production worker binding", () => {
    expect(parseObservabilityConfig({ NODE_ENV: "test" })).toMatchObject({
      enabled: true,
      logLevel: "info",
      readinessTimeoutMs: 5_000,
      metricsResponseMaxBytes: 65_536
    });
    expect(() => parseWorkerObservabilityConfig({ NODE_ENV: "production" })).toThrow(/HOST/);
    expect(() => parseWorkerObservabilityConfig({
      NODE_ENV: "production",
      WORKER_OBSERVABILITY_HOST: "0.0.0.0",
      WORKER_OBSERVABILITY_PORT: "9465"
    })).toThrow(/loopback/);
    expect(() => parseWorkerObservabilityConfig({
      NODE_ENV: "production",
      WORKER_OBSERVABILITY_HOST: "192.0.2.1",
      WORKER_OBSERVABILITY_PORT: "9465"
    })).toThrow(/loopback/);
  });

  it("bounds production log, readiness, metrics and listener values fail closed", () => {
    expect(parseWorkerObservabilityConfig({
      NODE_ENV: "production",
      WORKER_OBSERVABILITY_HOST: "127.0.0.1",
      WORKER_OBSERVABILITY_PORT: "9465",
      OBSERVABILITY_READINESS_TIMEOUT_MS: "100",
      OBSERVABILITY_METRICS_MAX_BYTES: "4096"
    })).toMatchObject({ host: "127.0.0.1", port: 9465, readinessTimeoutMs: 100, metricsResponseMaxBytes: 4096 });
    for (const port of ["0", "65536", "1.5", "unknown"]) {
      expect(() => parseWorkerObservabilityConfig({
        NODE_ENV: "production",
        WORKER_OBSERVABILITY_HOST: "127.0.0.1",
        WORKER_OBSERVABILITY_PORT: port
      })).toThrow(/PORT/);
    }
    for (const value of ["99", "30001", "unknown"]) {
      expect(() => parseObservabilityConfig({ OBSERVABILITY_READINESS_TIMEOUT_MS: value })).toThrow(/READINESS/);
    }
    for (const value of ["4095", "262145", "unknown"]) {
      expect(() => parseObservabilityConfig({ OBSERVABILITY_METRICS_MAX_BYTES: value })).toThrow(/METRICS/);
    }
    expect(() => parseObservabilityConfig({ NODE_ENV: "production", OBSERVABILITY_ENABLED: "false" })).toThrow(/required/);
    expect(() => parseObservabilityConfig({ OBSERVABILITY_LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("does not require worker listener variables for the migration role", () => {
    expect(parseObservabilityConfig({ NODE_ENV: "production", APP_PROCESS_ROLE: "migration" })).toMatchObject({
      enabled: true,
      logLevel: "info"
    });
  });

  it("loads validated production release metadata without Git or hostname data", async () => {
    const metadata = await createProcessMetadata({
      source: { NODE_ENV: "production", APP_PROCESS_ROLE: "worker" },
      role: "worker",
      processInstanceId: () => "f".repeat(32),
      readManifest: async () => JSON.stringify({
        schemaVersion: 1,
        application: { name: "videosave", version: "1.0.0" },
        build: { gitCommit: "a".repeat(40) }
      })
    });
    expect(metadata).toEqual({
      schemaVersion: "1.0",
      service: "videosave",
      processRole: "worker",
      processInstanceId: "f".repeat(32),
      releaseCommit: "a".repeat(40),
      releaseId: "videosave-1.0.0-aaaaaaaaaaaa",
      releaseCategory: "production"
    });
    expect(JSON.stringify(metadata)).not.toContain(process.cwd());
    expect(JSON.stringify(metadata)).not.toContain(String(process.pid));
  });

  it("fails closed for missing or incompatible production metadata", async () => {
    await expect(createProcessMetadata({
      source: { NODE_ENV: "production", APP_PROCESS_ROLE: "web" },
      role: "web",
      processInstanceId: () => "f".repeat(32),
      readManifest: async () => { throw new Error("missing"); }
    })).rejects.toThrow(/unavailable/);
    await expect(createProcessMetadata({
      source: { NODE_ENV: "production", APP_PROCESS_ROLE: "web" },
      role: "web",
      processInstanceId: () => "f".repeat(32),
      readManifest: async () => "{}"
    })).rejects.toThrow(/incompatible/);
  });
});
