import { describe, expect, it, vi } from "vitest";
import type { JobLeaseQueue } from "@/lib/jobs/job-lease-queue";
import type { MediaJobRecord } from "@/lib/jobs/types";
import { observeJobLeaseQueue } from "@/lib/observability/job-queue-observer";
import { createProcessObservability } from "@/lib/observability/runtime";

function record(overrides: Partial<MediaJobRecord> = {}): MediaJobRecord {
  return Object.freeze({
    jobId: "job_observed",
    status: "queued",
    processingPreset: "original",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    cancellationRequestedAt: null,
    progress: 0,
    sourceMetadata: null,
    finalMetadata: null,
    canonicalError: null,
    retryCount: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    version: 1,
    ...overrides
  });
}

function queue(overrides: Partial<JobLeaseQueue> = {}): JobLeaseQueue {
  return {
    enqueue: vi.fn(async () => ({ outcome: "created", record: record() })),
    claimNext: vi.fn(async () => ({ outcome: "empty" })),
    requestCancellation: vi.fn(async () => ({ outcome: "not-found" })),
    observeOwnedState: vi.fn(async () => ({ outcome: "not-found" })),
    renewLease: vi.fn(async () => ({ outcome: "not-found" })),
    setSourceMetadataOwned: vi.fn(async () => ({ outcome: "not-found" })),
    updateProgressOwned: vi.fn(async () => ({ outcome: "not-found" })),
    completeOwned: vi.fn(async () => ({ outcome: "not-found" })),
    recoverExpiredLeases: vi.fn(async () => ({ requeued: [], failed: [] })),
    ...overrides
  } as JobLeaseQueue;
}

describe("observed durable job queue", () => {
  it("emits canonical queued/retry events and increments terminal counters exactly once", async () => {
    const records: Array<Record<string, unknown>> = [];
    const runtime = await createProcessObservability({ NODE_ENV: "test" }, "worker", {
      metadata: { processInstanceId: () => "2".repeat(32) },
      logger: { sink: (recordValue) => { records.push(recordValue as Record<string, unknown>); } }
    });
    const base = queue({
      recoverExpiredLeases: vi.fn(async () => ({
        requeued: [record({ retryCount: 1 })],
        failed: [record({ jobId: "job_exhausted", status: "failed", startedAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:02.000Z", expiresAt: "2026-01-01T01:00:02.000Z", canonicalError: { code: "PROCESSING_FAILED", message: "safe" } })]
      }))
    });
    const observed = observeJobLeaseQueue(base, runtime.signals, () => Date.UTC(2026, 0, 1));
    await observed.enqueue({ jobId: "job_observed", sourceUrl: "https://example.test/media", formatId: "best", processingPreset: "original" });
    await observed.recoverExpiredLeases();
    const events = records.map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(["job.queued", "job.retry_scheduled", "job.retry_exhausted"]));
    const output = runtime.metrics.registry.render();
    expect(output).toContain('jobs_submitted_total{preset="original"} 1');
    expect(output).toContain('jobs_retried_total{reasonCategory="internal"} 1');
    expect(output).toContain('retry_exhausted_total{reasonCategory="transcode"} 1');
    expect(output).not.toContain("https://");
    runtime.close();
  });

  it("does not emit info heartbeat noise and reports lease loss without owner/token fields", async () => {
    const records: Array<Record<string, unknown>> = [];
    const runtime = await createProcessObservability({ NODE_ENV: "test" }, "worker", {
      metadata: { processInstanceId: () => "3".repeat(32) },
      logger: { sink: (value) => { records.push(value as Record<string, unknown>); } }
    });
    const lease = { jobId: "job_observed", workerId: `worker_${"a".repeat(32)}`, attemptId: `attempt_${"b".repeat(32)}`, version: 1, leaseExpiresAt: "2026-01-01T00:01:00.000Z" };
    const observed = observeJobLeaseQueue(queue(), runtime.signals);
    await observed.renewLease(lease);
    expect(records.map((entry) => entry.event)).toEqual(["job.lease_lost"]);
    expect(JSON.stringify(records)).not.toContain(lease.workerId);
    expect(JSON.stringify(records)).not.toContain(lease.attemptId);
    runtime.close();
  });
});
