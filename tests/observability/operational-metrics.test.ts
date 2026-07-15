import { describe, expect, it } from "vitest";
import {
  ERROR_CATEGORIES,
  MEDIA_STAGES,
  PROCESSING_PRESETS,
  type ProcessMetadata
} from "@/lib/observability/contract";
import { createCoreMetrics } from "@/lib/observability/core-metrics";
import { registerOperationalMetrics } from "@/lib/observability/operational-metrics";

const metadata: ProcessMetadata = Object.freeze({
  schemaVersion: "1.0",
  service: "videosave",
  processRole: "worker",
  processInstanceId: "1".repeat(32),
  releaseCommit: "a".repeat(40),
  releaseId: "videosave-test",
  releaseCategory: "test"
});

describe("Phase A operational metrics", () => {
  it("records bounded job, worker, database, storage and maintenance signals", () => {
    const core = createCoreMetrics(metadata);
    const metrics = registerOperationalMetrics(core);
    metrics.jobSubmitted("original");
    metrics.jobCompleted("original", 4.5);
    metrics.jobFailed("compatible-mp4", "transcode", 2);
    metrics.stageDuration("transcode", "compatible-mp4", "failure", 1.5);
    metrics.setQueueSnapshot({ queued: 3, oldestQueuedAgeSeconds: 12, running: 2, staleLeases: 1 });
    metrics.setWorkerCapacity(4, 2);
    metrics.setPoolSnapshot({ up: true, active: 2, idle: 1, waiting: 0, migrationCompatible: true });
    metrics.setStorageSnapshot({ up: true, readOnly: false, markerValid: true, freeBytes: 1024, freeInodes: 50 });
    metrics.setMaintenanceLeader(true);
    metrics.maintenanceSuccess("reconciliation", 123);
    const rendered = core.registry.render();
    expect(rendered).toContain('jobs_submitted_total{preset="original"} 1');
    expect(rendered).toContain("queue_depth 3");
    expect(rendered).toContain("active_jobs 5");
    expect(rendered).toContain("worker_available_slots 2");
    expect(rendered).toContain("db_up 1");
    expect(rendered).toContain("storage_free_bytes 1024");
    expect(rendered).toContain('maintenance_last_success_timestamp{operation="reconciliation"} 123');
    expect(rendered).not.toContain("job_0123456789abcdef");
    expect(rendered).not.toContain("requestId");
  });

  it("rejects high-cardinality preset/category values and unsafe numeric updates", () => {
    const metrics = registerOperationalMetrics(createCoreMetrics(metadata));
    expect(() => metrics.jobSubmitted("job_user_value" as never)).toThrow(/allowlist/);
    expect(() => metrics.workerFailure("download", "raw database error" as never)).toThrow(/allowlist/);
    expect(() => metrics.jobsExpired(-1)).toThrow(/non-negative/);
    expect(() => metrics.setQueueSnapshot({ queued: Number.NaN, oldestQueuedAgeSeconds: 0, running: 0, staleLeases: 0 })).toThrow(/finite/);
  });

  it("keeps the complete fixed label domain within the configured response bound", () => {
    const core = createCoreMetrics(metadata);
    const metrics = registerOperationalMetrics(core);
    for (const preset of PROCESSING_PRESETS) {
      metrics.jobSubmitted(preset);
      metrics.jobCompleted(preset, 1);
      for (const category of ERROR_CATEGORIES) metrics.jobFailed(preset, category, 1);
    }
    for (const stage of MEDIA_STAGES) {
      for (const outcome of ["success", "failure", "cancelled"] as const) {
        metrics.stageDuration(stage, "unknown", outcome, 1);
      }
      for (const category of ERROR_CATEGORIES) metrics.workerFailure(stage, category);
    }
    const output = core.registry.render();
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024);
  });
});
