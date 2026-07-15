import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { OBSERVABILITY_SCHEMA_VERSION } from "@/lib/observability/contract";
// @ts-expect-error Linux release validation tooling is intentionally plain Node.js ESM.
import { INSTALLED_WORKER_MAX_LINE_BYTES, INSTALLED_WORKER_OBSERVABILITY_SCHEMA_VERSION, parseInstalledWorkerReadyLine, runChecked, stopInstalledProcess, validateInstalledReleaseReadiness, waitForInstalledWorkerReady } from "../../scripts/test-linux-installed-release.mjs";

const RELEASE_COMMIT = "a".repeat(40);
const RELEASE_ID = `videosave-1.0.0-${RELEASE_COMMIT.slice(0, 12)}`;
const STARTED_AT = Date.parse("2026-07-15T12:00:00.000Z");
const NOW = STARTED_AT + 10_000;

function readyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    timestamp: new Date(STARTED_AT + 1_000).toISOString(),
    level: "info",
    event: "process.ready",
    service: "videosave",
    processRole: "worker",
    processInstanceId: "b".repeat(32),
    releaseCommit: RELEASE_COMMIT,
    releaseId: RELEASE_ID,
    outcome: "success",
    reasonCode: "none",
    ...overrides
  };
}

function parserOptions(overrides: Record<string, unknown> = {}) {
  return {
    expectedReleaseCommit: RELEASE_COMMIT,
    expectedReleaseId: RELEASE_ID,
    startedAtMs: STARTED_AT,
    now: () => NOW,
    ...overrides
  };
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

describe("Linux installed release readiness flow", () => {
  it("applies migrations as the migration role before status and runtime readiness", async () => {
    const calls: Array<{
      entrypoint: string;
      args: string[];
      role: string | undefined;
      databaseUrl: string | undefined;
    }> = [];
    const execute = vi.fn(async (_node: string, command: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({
        entrypoint: command[0],
        args: command.slice(1),
        role: options.env.APP_PROCESS_ROLE,
        databaseUrl: options.env.DATABASE_URL
      });
      return { stdout: "", stderr: "" };
    });
    const common = {
      NODE_ENV: "test",
      DATABASE_URL: "disposable-release-database-value"
    };

    await validateInstalledReleaseReadiness({
      installedRoot: "/installed/release",
      common,
      workerEnvironment: { ...common, APP_PROCESS_ROLE: "worker" },
      execute
    });

    expect(calls).toEqual([
      { entrypoint: "scripts/postgres-migrations.mjs", args: ["apply"], role: "migration", databaseUrl: common.DATABASE_URL },
      { entrypoint: "scripts/postgres-migrations.mjs", args: ["status"], role: "migration", databaseUrl: common.DATABASE_URL },
      { entrypoint: "checks/web-readiness.mjs", args: [], role: "web", databaseUrl: common.DATABASE_URL },
      { entrypoint: "worker/main.mjs", args: ["--check"], role: "worker", databaseUrl: common.DATABASE_URL }
    ]);
  });

  it("reports only a fixed command label when an installed command fails", async () => {
    const secret = "sensitive-runtime-value";
    const execute = vi.fn(async () => {
      throw new Error(`failed ${secret} /private/runtime/hidden`);
    });

    await expect(runChecked("web-readiness", "checks/web-readiness.mjs", [], {
      cwd: "/installed/release",
      env: { DATABASE_URL: secret },
      execute
    })).rejects.toThrow("Installed release command failed: web-readiness.");

    try {
      await runChecked("web-readiness", "checks/web-readiness.mjs", [], {
        cwd: "/installed/release",
        env: { DATABASE_URL: secret },
        execute
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("/private/runtime/hidden");
    }
  });
});

describe("installed worker canonical readiness record", () => {
  it("stays locked to the server observability schema", () => {
    expect(INSTALLED_WORKER_OBSERVABILITY_SCHEMA_VERSION).toBe(OBSERVABILITY_SCHEMA_VERSION);
  });

  it("accepts only an exact current worker process.ready identity", () => {
    expect(parseInstalledWorkerReadyLine(JSON.stringify(readyRecord()), parserOptions())).toMatchObject({
      event: "process.ready",
      processRole: "worker",
      releaseCommit: RELEASE_COMMIT,
      releaseId: RELEASE_ID,
      outcome: "success"
    });
  });

  it.each([
    ["legacy text", "worker.ready"],
    ["malformed JSON", "{not-json"],
    ["substring only", JSON.stringify({ message: "process.ready" })],
    ["web role", JSON.stringify(readyRecord({ processRole: "web" }))],
    ["migration role", JSON.stringify(readyRecord({ processRole: "migration" }))],
    ["not-ready event", JSON.stringify(readyRecord({ event: "process.not_ready" }))],
    ["starting event", JSON.stringify(readyRecord({ event: "process.starting" }))],
    ["stopping event", JSON.stringify(readyRecord({ event: "process.stopping" }))],
    ["stopped event", JSON.stringify(readyRecord({ event: "process.stopped" }))],
    ["failure outcome", JSON.stringify(readyRecord({ outcome: "failure" }))],
    ["wrong service", JSON.stringify(readyRecord({ service: "other" }))],
    ["wrong release commit", JSON.stringify(readyRecord({ releaseCommit: "c".repeat(40) }))],
    ["commit prefix", JSON.stringify(readyRecord({ releaseCommit: RELEASE_COMMIT.slice(0, 12) }))],
    ["wrong release id", JSON.stringify(readyRecord({ releaseId: "videosave-1.0.0-cccccccccccc" }))],
    ["unsupported schema", JSON.stringify(readyRecord({ schemaVersion: "2.0" }))],
    ["stale timestamp", JSON.stringify(readyRecord({ timestamp: new Date(STARTED_AT - 1).toISOString() }))],
    ["future timestamp", JSON.stringify(readyRecord({ timestamp: new Date(NOW + 5_001).toISOString() }))],
    ["nested spoof", JSON.stringify({ metadata: readyRecord() })],
    ["raw control", JSON.stringify(readyRecord()).replace("videosave", "video\u0000save")]
  ])("rejects %s", (_label, line) => {
    expect(parseInstalledWorkerReadyLine(line, parserOptions())).toBeNull();
  });

  it("rejects every missing required field", () => {
    for (const field of [
      "schemaVersion", "timestamp", "level", "event", "service", "processRole",
      "processInstanceId", "releaseCommit", "releaseId", "outcome", "reasonCode"
    ]) {
      const record = readyRecord();
      delete record[field];
      expect(parseInstalledWorkerReadyLine(JSON.stringify(record), parserOptions())).toBeNull();
    }
  });

  it("rejects an oversized complete line", () => {
    const line = JSON.stringify(readyRecord({ metadata: "x".repeat(INSTALLED_WORKER_MAX_LINE_BYTES) }));
    expect(Buffer.byteLength(line)).toBeGreaterThan(INSTALLED_WORKER_MAX_LINE_BYTES);
    expect(parseInstalledWorkerReadyLine(line, parserOptions())).toBeNull();
  });
});

describe("installed worker readiness stream", () => {
  function monitor(timeoutMs = 1_000) {
    const child = new FakeChild();
    const stdout = new PassThrough();
    const promise = waitForInstalledWorkerReady({
      child,
      stdout,
      ...parserOptions(),
      timeoutMs
    });
    return { child, stdout, promise };
  }

  it("handles a JSON line split across chunks and removes listeners after success", async () => {
    const harness = monitor();
    const line = `${JSON.stringify(readyRecord())}\n`;
    harness.stdout.write(line.slice(0, 17));
    harness.stdout.write(line.slice(17, 91));
    harness.stdout.write(line.slice(91));
    await expect(harness.promise).resolves.toMatchObject({ event: "process.ready" });
    expect(harness.stdout.listenerCount("data")).toBe(0);
    expect(harness.stdout.listenerCount("end")).toBe(0);
    expect(harness.child.listenerCount("exit")).toBe(0);
  });

  it("handles multiple records in one chunk and ignores earlier unrelated records", async () => {
    const harness = monitor();
    harness.stdout.write([
      JSON.stringify(readyRecord({ event: "process.starting" })),
      JSON.stringify({ status: "unrelated" }),
      JSON.stringify(readyRecord()),
      JSON.stringify(readyRecord())
    ].join("\n") + "\n");
    await expect(harness.promise).resolves.toMatchObject({ event: "process.ready" });
    expect(harness.stdout.listenerCount("data")).toBe(0);
  });

  it("fails closed on an oversized pending buffer and invalid UTF-8", async () => {
    const oversized = monitor();
    oversized.stdout.write(Buffer.alloc(INSTALLED_WORKER_MAX_LINE_BYTES + 1, 0x61));
    await expect(oversized.promise).rejects.toThrow("output is invalid");

    const invalidUtf8 = monitor();
    invalidUtf8.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    await expect(invalidUtf8.promise).rejects.toThrow("output is invalid");
  });

  it("does not use stderr as readiness authority and keeps timeout bounded", async () => {
    vi.useFakeTimers();
    try {
      const harness = monitor(100);
      const stderr = new PassThrough();
      stderr.write(`${JSON.stringify(readyRecord())}\n`);
      const rejected = expect(harness.promise).rejects.toThrow("readiness timed out");
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(harness.stdout.listenerCount("data")).toBe(0);
      expect(harness.child.listenerCount("exit")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports early worker exit without leaking listeners", async () => {
    const harness = monitor();
    harness.child.exitCode = 1;
    harness.child.emit("exit", 1, null);
    await expect(harness.promise).rejects.toThrow("exited before readiness");
    expect(harness.stdout.listenerCount("data")).toBe(0);
    expect(harness.child.listenerCount("exit")).toBe(0);
  });
});

describe("installed worker SIGTERM lifecycle", () => {
  it("signals once and clears its shutdown timer after graceful exit", async () => {
    const child = new FakeChild();
    child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      }
      return true;
    });
    await stopInstalledProcess(child, "Installed worker", 1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("recognizes a real child readiness record before graceful SIGTERM shutdown", async () => {
    const startedAtMs = Date.now() - 100;
    const record = readyRecord({ timestamp: new Date().toISOString() });
    const child = spawn(process.execPath, ["-e", [
      "process.stdout.write(process.env.READY_RECORD + '\\n');",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);"
    ].join("")], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", READY_RECORD: JSON.stringify(record) },
      stdio: ["ignore", "pipe", "ignore"] as const
    });
    try {
      await expect(waitForInstalledWorkerReady({
        child,
        stdout: child.stdout,
        ...parserOptions({ startedAtMs, now: Date.now }),
        timeoutMs: 5_000
      })).resolves.toMatchObject({ event: "process.ready" });
      await stopInstalledProcess(child, "Installed worker", 5_000);
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
