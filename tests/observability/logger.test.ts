import { describe, expect, it, vi } from "vitest";
import type { ProcessMetadata } from "@/lib/observability/contract";
import { createOperationalLogger, type OperationalLogRecord } from "@/lib/observability/logger";
import { classifyError, redactValue, REDACTED_VALUE } from "@/lib/observability/redaction";

const metadata: ProcessMetadata = Object.freeze({
  schemaVersion: "1.0",
  service: "videosave",
  processRole: "web",
  processInstanceId: "1".repeat(32),
  releaseCommit: "a".repeat(40),
  releaseId: "videosave-1.0.0-aaaaaaaaaaaa",
  releaseCategory: "test"
});

function harness() {
  const records: OperationalLogRecord[] = [];
  const lines: string[] = [];
  const logger = createOperationalLogger({
    metadata,
    level: "debug",
    now: () => new Date("2026-07-15T12:00:00.000Z"),
    sink(record, line) { records.push(record); lines.push(line); }
  });
  return { logger, records, lines };
}

describe("structured operational logger", () => {
  it("emits one deterministic JSON line with the canonical base schema", () => {
    const { logger, records, lines } = harness();
    logger.info("process.ready", { outcome: "success", reasonCode: "none", durationMs: 12.3456 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0])).toEqual(records[0]);
    expect(records[0]).toMatchObject({
      schemaVersion: "1.0",
      timestamp: "2026-07-15T12:00:00.000Z",
      level: "info",
      event: "process.ready",
      service: "videosave",
      processRole: "web",
      processInstanceId: "1".repeat(32),
      releaseCommit: "a".repeat(40),
      releaseId: "videosave-1.0.0-aaaaaaaaaaaa",
      outcome: "success",
      reasonCode: "none",
      durationMs: 12.346
    });
  });

  it("fails closed for an unknown event without reflecting it", () => {
    const { logger, records } = harness();
    logger.info("attacker\n.event", { metadata: { harmless: true } });
    expect(records[0]).toMatchObject({ event: "config.invalid", reasonCode: "invalid_event" });
    expect(JSON.stringify(records[0])).not.toContain("attacker");
  });

  it("recursively redacts credentials, URLs, payloads, paths, SQL, and FFmpeg stderr", () => {
    const { logger, lines } = harness();
    const databaseUrl = ["postgresql://user", "password@db.example/app"].join(":");
    const testDatabaseUrl = ["postgres://test", "secret@localhost/db"].join(":");
    const absolutePath = ["", "Users", "example", "private", "input.mp4"].join("/");
    const privatePath = ["", "private", "tmp", "input.mp4"].join("/");
    logger.warn("process.not_ready", {
      outcome: "failure",
      reasonCode: "readiness_failed",
      metadata: {
        DATABASE_URL: databaseUrl,
        test_database_url: testDatabaseUrl,
        Authorization: "Bearer top-secret",
        cookie: "session=secret",
        sourceUrl: "https://media.example/watch?v=token",
        durablePayload: { token: "secret" },
        absolutePath,
        sql: "SELECT payload FROM media_jobs",
        ffmpegStderr: `input ${privatePath}\nsecret`
      }
    });
    const line = lines[0];
    for (const secret of ["password", "top-secret", "session=", "media.example", absolutePath, "SELECT payload", privatePath]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain(REDACTED_VALUE);
  });

  it("neutralizes controls and survives circular values, BigInt, and throwing getters", () => {
    const circular: Record<string, unknown> = { text: "alpha\nbeta\u0000gamma", large: 12n };
    circular.self = circular;
    Object.defineProperty(circular, "trap", { enumerable: true, get() { throw new Error("secret getter"); } });
    const { logger, lines } = harness();
    expect(() => logger.info("process.ready", { metadata: circular })).not.toThrow();
    expect(lines[0]).not.toContain("secret getter");
    expect(lines[0]).not.toContain("\u0000");
    expect(lines[0]).toContain("[CIRCULAR]");
    expect(lines[0].length).toBeLessThanOrEqual(8 * 1024);
  });

  it("does not let sink failures escape into runtime behavior", () => {
    const logger = createOperationalLogger({ metadata, sink() { throw new Error("sink failed"); } });
    expect(() => logger.error("process.not_ready", { outcome: "failure", reasonCode: "internal_error" })).not.toThrow();
  });
});

describe("redaction and error classification", () => {
  it("bounds depth, arrays, keys, and strings", () => {
    const value = redactValue({
      long: "x".repeat(2_000),
      items: Array.from({ length: 100 }, (_, index) => index),
      nested: { a: { b: { c: { d: { secret: "value" } } } } }
    });
    const encoded = JSON.stringify(value);
    expect(encoded.length).toBeLessThan(2_000);
    expect(encoded).toContain("[TRUNCATED]");
  });

  it("classifies without using raw Error.message", () => {
    const error = Object.assign(new Error("postgresql://user:secret@db/app"), { code: "ECONNREFUSED" });
    expect(classifyError(error)).toEqual({ category: "network", reasonCode: "dependency_unavailable" });
    expect(JSON.stringify(classifyError(error))).not.toContain("secret");
  });
});
