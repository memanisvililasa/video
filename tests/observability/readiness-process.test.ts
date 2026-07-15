import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PostgresSchemaCompatibilityError } from "@/lib/jobs/postgres/schema-readiness";
import type { OperationalLogRecord } from "@/lib/observability/logger";
import { createReadinessProbe } from "@/lib/observability/readiness-probe";
import { createProcessObservability, installProcessLifecycleLogging } from "@/lib/observability/runtime";

async function runtimeHarness(role: "web" | "worker" = "web") {
  const records: OperationalLogRecord[] = [];
  const runtime = await createProcessObservability(
    { NODE_ENV: "test", OBSERVABILITY_LOG_LEVEL: "debug" },
    role,
    {
      metadata: { processInstanceId: () => "1".repeat(32) },
      logger: { sink(record) { records.push(record); } }
    }
  );
  return { runtime, records };
}

describe("bounded readiness probe", () => {
  it("single-flights concurrent checks and logs only readiness transitions", async () => {
    const { runtime, records } = await runtimeHarness();
    let calls = 0;
    const probe = createReadinessProbe({
      check: async () => { calls += 1; },
      timeoutMs: 500,
      metrics: runtime.metrics,
      logger: runtime.logger
    });
    const first = probe.check();
    const second = probe.check();
    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ready: true, reasonCategory: "none" },
      { ready: true, reasonCategory: "none" }
    ]);
    await expect(probe.check()).resolves.toEqual({ ready: true, reasonCategory: "none" });
    expect(calls).toBe(2);
    expect(records.filter((record) => record.event === "db.connected")).toHaveLength(1);
    expect(runtime.metrics.registry.render()).toContain('readiness_status{role="web"} 1');
  });

  it("times out without starting unbounded duplicate checks", async () => {
    const { runtime } = await runtimeHarness();
    let resolveDependency!: () => void;
    let calls = 0;
    const pending = new Promise<void>((resolve) => { resolveDependency = resolve; });
    const probe = createReadinessProbe({
      check: () => { calls += 1; return pending; },
      timeoutMs: 100,
      metrics: runtime.metrics,
      logger: runtime.logger
    });
    await expect(probe.check()).resolves.toEqual({ ready: false, reasonCategory: "timeout" });
    await expect(probe.check()).resolves.toEqual({ ready: false, reasonCategory: "timeout" });
    expect(calls).toBe(1);
    resolveDependency();
    await pending;
    await Promise.resolve();
  });

  it("classifies exact schema mismatch without exposing details", async () => {
    const { runtime, records } = await runtimeHarness();
    const probe = createReadinessProbe({
      check: async () => { throw new PostgresSchemaCompatibilityError(); },
      timeoutMs: 500,
      metrics: runtime.metrics,
      logger: runtime.logger
    });
    await expect(probe.check()).resolves.toEqual({ ready: false, reasonCategory: "configuration" });
    expect(records.some((record) => record.event === "migration.mismatch" && record.reasonCode === "schema_mismatch")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("_videosave_migrations");
  });
});

describe("process lifecycle logging", () => {
  it("logs starting/ready and exactly one stopping/stopped transition", async () => {
    const { runtime, records } = await runtimeHarness("worker");
    const emitter = new EventEmitter();
    const remove = installProcessLifecycleLogging(runtime, emitter as never);
    emitter.emit("SIGTERM");
    emitter.emit("SIGINT");
    emitter.emit("exit");
    emitter.emit("exit");
    expect(records.map((record) => record.event)).toEqual([
      "process.starting",
      "process.ready",
      "process.stopping",
      "process.stopped"
    ]);
    expect(runtime.metrics.registry.render()).toContain("process_up 0");
    remove();
  });
});
