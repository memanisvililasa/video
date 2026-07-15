import { describe, expect, it } from "vitest";
import {
  parseApplicationProcessRole,
  parseProductionWebConfig
} from "@/lib/config/env";

function webEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_PROCESS_ROLE: "web",
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: "postgresql://web:secret@database.internal/videosave",
    POSTGRES_SSL_MODE: "disable",
    MEDIA_STORAGE_BACKEND: "durable-volume",
    MEDIA_STORAGE_ROOT: "/srv/videosave-media",
    MEDIA_STORAGE_AUTHORITY_ID: "0123456789abcdef0123456789abcdef",
    NODE_ENV: "test",
    ...overrides
  };
}

describe("application process roles", () => {
  it("defaults only non-production environments to local", () => {
    expect(parseApplicationProcessRole({})).toBe("local");
    expect(parseApplicationProcessRole({ NODE_ENV: "test" })).toBe("local");
    expect(() => parseApplicationProcessRole({ NODE_ENV: "production" })).toThrow("required");
  });

  it.each(["local", "web", "worker", "migration"] as const)(
    "accepts the explicit %s role outside production",
    (role) => expect(parseApplicationProcessRole({ APP_PROCESS_ROLE: role })).toBe(role)
  );

  it("rejects unknown roles and production local fallback", () => {
    expect(() => parseApplicationProcessRole({ APP_PROCESS_ROLE: "api" })).toThrow("APP_PROCESS_ROLE");
    expect(() => parseApplicationProcessRole({
      APP_PROCESS_ROLE: "local",
      NODE_ENV: "production"
    })).toThrow("not permitted");
  });

  it("requires an all-persistent web composition", () => {
    expect(parseProductionWebConfig(webEnvironment())).toMatchObject({
      role: "web",
      ingress: { hostname: "127.0.0.1", port: 3000, trustProxyMode: "none" },
      repository: { backend: "postgres" },
      storage: { backend: "durable-volume", root: "/srv/videosave-media" }
    });
    expect(() => parseProductionWebConfig(webEnvironment({
      JOB_REPOSITORY_BACKEND: "memory"
    }))).toThrow("postgres");
    expect(() => parseProductionWebConfig(webEnvironment({
      MEDIA_STORAGE_BACKEND: "local"
    }))).toThrow("durable-volume");
    expect(() => parseProductionWebConfig(webEnvironment({
      APP_PROCESS_ROLE: "worker"
    }))).toThrow("web");
  });

  it.each(["127.0.0.1", "::1", "localhost"])(
    "accepts the approved production loopback %s",
    (hostname) => {
      expect(parseProductionWebConfig(webEnvironment({
        NODE_ENV: "production",
        POSTGRES_SSL_MODE: "require",
        HOSTNAME: hostname,
        PORT: "3000",
        TRUST_PROXY_MODE: "nginx-single-host"
      })).ingress).toMatchObject({ hostname, port: 3000, trustProxyMode: "nginx-single-host" });
    }
  );

  it.each(["0.0.0.0", "::", "192.0.2.10", "database.internal"])(
    "rejects production bind host %s",
    (hostname) => {
      expect(() => parseProductionWebConfig(webEnvironment({
        NODE_ENV: "production",
        POSTGRES_SSL_MODE: "require",
        HOSTNAME: hostname,
        PORT: "3000",
        TRUST_PROXY_MODE: "nginx-single-host"
      }))).toThrow("loopback");
    }
  );

  it("requires an explicit production port and trusted Nginx mode", () => {
    const production = {
      NODE_ENV: "production",
      POSTGRES_SSL_MODE: "require",
      HOSTNAME: "127.0.0.1",
      PORT: "3000",
      TRUST_PROXY_MODE: "nginx-single-host"
    };
    expect(() => parseProductionWebConfig(webEnvironment({ ...production, PORT: undefined })))
      .toThrow("PORT");
    expect(() => parseProductionWebConfig(webEnvironment({
      ...production,
      TRUST_PROXY_MODE: undefined
    }))).toThrow("nginx-single-host");
    expect(() => parseProductionWebConfig(webEnvironment({
      ...production,
      TRUST_PROXY_MODE: "unknown"
    }))).toThrow("TRUST_PROXY_MODE");
  });

  it("validates only web queue inputs and ignores worker-only settings", () => {
    expect(() => parseProductionWebConfig(webEnvironment({
      WORKER_CONCURRENCY: "invalid",
      JOB_LEASE_DURATION_MS: "1",
      JOB_LEASE_RENEW_INTERVAL_MS: "999999",
      JOB_RECOVERY_INTERVAL_MS: "1",
      JOB_MAX_RETRIES: "999"
    }))).not.toThrow();
    expect(() => parseProductionWebConfig(webEnvironment({
      JOB_ACTIVE_TTL_SECONDS: "1"
    }))).toThrow("JOB_ACTIVE_TTL_SECONDS");
  });

  it("never reads TEST_DATABASE_URL as the production web database", () => {
    expect(() => parseProductionWebConfig(webEnvironment({
      DATABASE_URL: undefined,
      TEST_DATABASE_URL: "postgresql://test:secret@localhost/test"
    }))).toThrow("DATABASE_URL");
  });
});
