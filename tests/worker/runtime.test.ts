import { describe, expect, it } from "vitest";
import type {
  ClaimedMediaJob,
  JobLeaseQueue,
  JobLeaseRef,
  OwnedJobUpdateResult
} from "@/lib/jobs/job-lease-queue";
import type { MediaJobRecord } from "@/lib/jobs/types";
import type { FinalPublicationCoordinator, MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import type { MediaWorkerProcessor } from "@/lib/worker/processor";
import { createMediaWorkerRuntime } from "@/lib/worker/runtime";
import type { WorkerLogger } from "@/lib/worker/logger";

const logger: WorkerLogger = Object.freeze({ info() {}, warn() {}, error() {} });

function record(jobId: string): MediaJobRecord {
  return Object.freeze({
    jobId,
    status: "running",
    processingPreset: "original",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    expiresAt: null,
    cancellationRequestedAt: null,
    progress: 0,
    sourceMetadata: null,
    finalMetadata: null,
    canonicalError: null,
    retryCount: 0,
    leaseOwner: `worker_${"a".repeat(32)}`,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    version: 2
  });
}

function claimed(jobId: string): ClaimedMediaJob {
  const lease: JobLeaseRef = Object.freeze({
    jobId,
    workerId: `worker_${"a".repeat(32)}`,
    attemptId: `attempt_${jobId.slice(-1).padStart(32, "a")}`,
    version: 2,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z"
  });
  return Object.freeze({
    record: record(jobId),
    lease,
    workItem: Object.freeze({
      sourceUrl: "https://media.example.test/video.mp4",
      formatId: "direct-source",
      processingPreset: "original"
    })
  });
}

function createFakeQueue(jobs: ClaimedMediaJob[], options: {
  cancelRenew?: boolean;
  renewThrows?: boolean;
  renewThrowsCount?: number;
  cancelObservation?: boolean;
} = {}) {
  let claimCalls = 0;
  let renewCalls = 0;
  const queue = {
    async claimNext() {
      claimCalls += 1;
      const job = jobs.shift();
      return job ? { outcome: "claimed" as const, job } : { outcome: "empty" as const };
    },
    async recoverExpiredLeases() { return { requeued: [], failed: [] }; },
    async observeOwnedState(lease: JobLeaseRef) {
      if (options.cancelObservation) {
        return { outcome: "cancelled" as const, record: { ...record(lease.jobId), status: "cancelled" as const } };
      }
      return { outcome: "active" as const, record: { ...record(lease.jobId), version: lease.version } };
    },
    async renewLease(lease: JobLeaseRef): Promise<OwnedJobUpdateResult> {
      renewCalls += 1;
      if (options.renewThrows || renewCalls <= (options.renewThrowsCount ?? 0)) throw new Error("database unavailable");
      if (options.cancelRenew) return { outcome: "cancelled", record: { ...record(lease.jobId), status: "cancelled" } };
      const next = { ...lease, version: lease.version + 1 };
      return { outcome: "updated", record: { ...record(lease.jobId), version: next.version }, lease: next };
    },
    async updateProgressOwned(lease: JobLeaseRef): Promise<OwnedJobUpdateResult> {
      const next = { ...lease, version: lease.version + 1 };
      return { outcome: "updated", record: { ...record(lease.jobId), version: next.version }, lease: next };
    },
    async completeOwned() { return { outcome: "ownership-lost" as const }; }
  } as unknown as JobLeaseQueue;
  return { queue, claimCalls: () => claimCalls, renewCalls: () => renewCalls };
}

function runtime(queue: JobLeaseQueue, processor: MediaWorkerProcessor, overrides: Partial<Parameters<typeof createMediaWorkerRuntime>[0]> = {}) {
  const artifacts = { isOwnedLeaseActive: async () => true } as unknown as MediaArtifactRepository;
  const publication = {} as FinalPublicationCoordinator;
  return createMediaWorkerRuntime({
    queue,
    artifacts,
    publication,
    processor,
    logger,
    concurrency: 2,
    workerIdPrefix: "test",
    pollIntervalMs: 2,
    progressIntervalMs: 2,
    renewalIntervalMs: 5,
    leaseDurationMs: 50,
    cancellationPollIntervalMs: 5,
    dbLossGraceMs: 0,
    attemptTimeoutMs: 500,
    shutdownGraceMs: 20,
    random: () => 0.5,
    ...overrides
  });
}

describe("media worker runtime", () => {
  it("polls without a busy loop and shuts down idempotently", async () => {
    const fake = createFakeQueue([]);
    const worker = runtime(fake.queue, { process: async () => undefined });
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await Promise.all([worker.shutdown(), worker.shutdown()]);
    await running;
    expect(fake.claimCalls()).toBeGreaterThan(1);
    expect(fake.claimCalls()).toBeLessThan(20);
    expect(worker.status()).toMatchObject({ running: false, activeJobs: 0 });
  });

  it("never exceeds configured concurrency", async () => {
    const fake = createFakeQueue([claimed("job_a"), claimed("job_b"), claimed("job_c")]);
    let active = 0;
    let maximum = 0;
    const worker = runtime(fake.queue, {
      async process({ session }) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        session.abort("ownership-lost");
        active -= 1;
        throw new Error("stop");
      }
    });
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await worker.shutdown();
    await running;
    expect(maximum).toBe(2);
  });

  it("aborts local processing when renewal observes cancellation", async () => {
    const fake = createFakeQueue([claimed("job_c")], { cancelRenew: true });
    let aborted = false;
    const worker = runtime(fake.queue, {
      async process({ session }) {
        await new Promise<void>((resolve) => {
          session.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
        });
        throw new Error("cancelled");
      }
    }, { concurrency: 1 });
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();
    await running;
    expect(fake.renewCalls()).toBeGreaterThan(0);
    expect(aborted).toBe(true);
  });

  it("observes persistent cancellation independently of progress and renewal", async () => {
    const fake = createFakeQueue([claimed("job_f")], { cancelObservation: true });
    let abortReason: string | null = null;
    const worker = runtime(fake.queue, {
      async process({ session }) {
        await new Promise<void>((resolve) => {
          session.signal.addEventListener("abort", () => { abortReason = session.abortReason(); resolve(); }, { once: true });
        });
        throw new Error("cancelled");
      }
    }, { concurrency: 1, renewalIntervalMs: 100, cancellationPollIntervalMs: 5, leaseDurationMs: 500 });
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();
    await running;
    expect(abortReason).toBe("cancellation");
    expect(fake.renewCalls()).toBe(0);
  });

  it("tolerates a transient renewal transport failure inside the DB-loss grace", async () => {
    const fake = createFakeQueue([claimed("job_g")], { renewThrowsCount: 1 });
    let abortedReason: string | null = null;
    const worker = runtime(fake.queue, {
      async process({ session }) {
        session.signal.addEventListener("abort", () => { abortedReason = session.abortReason(); }, { once: true });
        await new Promise((resolve) => setTimeout(resolve, 30));
        session.abort("ownership-lost");
        throw new Error("test complete");
      }
    }, { concurrency: 1, dbLossGraceMs: 200 });
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await worker.shutdown();
    await running;
    expect(fake.renewCalls()).toBeGreaterThan(0);
    expect(abortedReason).toBe("ownership-lost");
  });

  it("treats a renewal transport failure as uncertain ownership and aborts fail-closed", async () => {
    const fake = createFakeQueue([claimed("job_e")], { renewThrows: true });
    let abortReason: string | null = null;
    const worker = runtime(fake.queue, {
      async process({ session }) {
        await new Promise<void>((resolve) => {
          session.signal.addEventListener("abort", () => { abortReason = session.abortReason(); resolve(); }, { once: true });
        });
        throw new Error("database unavailable");
      }
    }, { concurrency: 1 });
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.shutdown();
    await running;
    expect(abortReason).toBe("db-transport");
  });

  it("aborts running work after shutdown grace and leaves no active session", async () => {
    const fake = createFakeQueue([claimed("job_d")]);
    let aborted = false;
    const worker = runtime(fake.queue, {
      async process({ session }) {
        await new Promise<void>((resolve) => {
          session.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
        });
        throw new Error("shutdown");
      }
    }, { concurrency: 1, shutdownGraceMs: 5 });
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.shutdown();
    await running;
    expect(aborted).toBe(true);
    expect(worker.status().activeJobs).toBe(0);
  });
});
