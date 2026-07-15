import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetricsCollectorCoordinator } from "@/lib/observability/collectors";
import { createPostgresMetricsCollector } from "@/lib/observability/postgres-collector";
import { createProcessObservability } from "@/lib/observability/runtime";
import { createStorageMetricsCollector } from "@/lib/observability/storage-collector";
import { provisionDurableVolumeTestRoot, TEST_DURABLE_VOLUME_AUTHORITY_ID } from "@/tests/helpers/durable-volume";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("bounded operational collectors", () => {
  it("single-flights concurrent collection and bounds a stalled collector", async () => {
    const coordinator = createMetricsCollectorCoordinator({ timeoutMs: 100 });
    const collect = vi.fn(() => new Promise<void>(() => undefined));
    coordinator.add({ name: "stalled", collect });
    await Promise.all([coordinator.collect(), coordinator.collect(), coordinator.collect()]);
    expect(collect).toHaveBeenCalledTimes(1);
    coordinator.close();
  });

  it("collects marker, capacity and inode state without walking the durable tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "videosave-observability-storage-"));
    roots.push(root);
    await provisionDurableVolumeTestRoot(root);
    const runtime = await createProcessObservability({ NODE_ENV: "test" }, "worker", {
      metadata: { processInstanceId: () => "4".repeat(32) }, logger: { sink() {} }
    });
    const collector = createStorageMetricsCollector({ root, authorityId: TEST_DURABLE_VOLUME_AUTHORITY_ID, signals: runtime.signals, cacheTtlMs: 1_000 });
    await collector.collect();
    const output = runtime.metrics.registry.render();
    expect(output).toContain("storage_up 1");
    expect(output).toContain("storage_marker_valid 1");
    expect(output).toMatch(/storage_free_bytes \d+/);
    expect(output).toMatch(/storage_free_inodes \d+/);
    expect(output).not.toContain(root);
    runtime.close();
  });

  it("distinguishes a readable read-only root and an invalid marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "videosave-observability-readonly-"));
    roots.push(root);
    await provisionDurableVolumeTestRoot(root);
    const runtime = await createProcessObservability({ NODE_ENV: "test" }, "worker", {
      metadata: { processInstanceId: () => "8".repeat(32) }, logger: { sink() {} }
    });
    await chmod(root, 0o500);
    try {
      await createStorageMetricsCollector({ root, authorityId: TEST_DURABLE_VOLUME_AUTHORITY_ID, signals: runtime.signals, cacheTtlMs: 1_000 }).collect();
      const output = runtime.metrics.registry.render();
      expect(output).toContain("storage_up 1");
      expect(output).toContain("storage_read_only 1");
    } finally {
      await chmod(root, 0o700);
    }
    runtime.close();

    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "videosave-observability-unmarked-"));
    roots.push(missingRoot);
    const missing = await createProcessObservability({ NODE_ENV: "test" }, "web", {
      metadata: { processInstanceId: () => "9".repeat(32) }, logger: { sink() {} }
    });
    await createStorageMetricsCollector({ root: missingRoot, authorityId: TEST_DURABLE_VOLUME_AUTHORITY_ID, signals: missing.signals, cacheTtlMs: 1_000 }).collect();
    expect(missing.metrics.registry.render()).toContain("storage_marker_valid 0");
    expect(missing.metrics.registry.render()).toContain("storage_up 0");
    missing.close();
  });

  it("fails PostgreSQL snapshot gauges closed without exposing database errors", async () => {
    const records: string[] = [];
    const runtime = await createProcessObservability({ NODE_ENV: "test" }, "web", {
      metadata: { processInstanceId: () => "5".repeat(32) },
      logger: { sink: (_record, line) => { records.push(line); } }
    });
    const pool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      connect: vi.fn(async () => { throw new Error("postgresql://user:secret@host/db"); })
    };
    await createPostgresMetricsCollector({ pool: pool as never, signals: runtime.signals, cacheTtlMs: 1_000 }).collect();
    expect(runtime.metrics.registry.render()).toContain("db_up 0");
    expect(records.join("\n")).not.toContain("secret");
    expect(records.join("\n")).not.toContain("postgresql://");
    runtime.close();
  });
});
