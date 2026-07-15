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
