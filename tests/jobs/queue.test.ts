import { describe, expect, it, vi } from "vitest";
import { API_ERROR_MESSAGES, AppError } from "@/lib/errors";
import {
  assertMediaJobTransition,
  createMediaJobQueue,
  MEDIA_JOB_QUEUE_LIMITS
} from "@/lib/jobs/queue";
import type {
  MediaJobHandler,
  MediaJobResult,
  MediaJobSnapshot,
  MediaJobStatus
} from "@/lib/jobs/types";
import { API_ERROR_CODES } from "@/lib/types";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function safeResult(suffix: string): MediaJobResult {
  const fileId = `file_${suffix}`;
  return {
    fileId,
    downloadUrl: `/api/file/${fileId}`,
    filename: `${suffix}.mp4`,
    sizeBytes: 1024,
    mimeType: "video/mp4",
    expiresAt: "2026-01-01T01:00:00.000Z",
    processingPreset: "original",
    media: {
      durationSeconds: 12,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac"
    }
  };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function createHarness(options: {
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
  terminalTtlMs?: number;
} = {}) {
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  let nextId = 1;
  const queue = createMediaJobQueue({
    maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
    maxQueuedJobs: options.maxQueuedJobs ?? 10,
    terminalTtlMs: options.terminalTtlMs ?? 60_000,
    now: () => nowMs,
    createJobId: () => `job_${nextId++}`
  });

  return {
    queue,
    now: () => nowMs,
    advanceBy(milliseconds: number) {
      nowMs += milliseconds;
    }
  };
}

function captureAppError(operation: () => unknown): AppError {
  try {
    operation();
    throw new Error("Expected operation to throw an AppError.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

async function captureAsyncAppError(operation: () => Promise<unknown>): Promise<AppError> {
  try {
    await operation();
    throw new Error("Expected operation to reject with an AppError.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
}

describe("in-memory media job queue", () => {
  it("moves one job through queued, running and ready", async () => {
    const harness = createHarness();
    const work = deferred<MediaJobResult>();
    const enqueued = harness.queue.enqueue({
      processingPreset: "compatible-mp4",
      handler: () => work.promise
    });

    expect(enqueued).toMatchObject({
      jobId: "job_1",
      snapshot: { status: "queued", progress: 0, processingPreset: "compatible-mp4" }
    });
    await flushMicrotasks();
    expect(harness.queue.getJob(enqueued.jobId)).toMatchObject({
      status: "running",
      progress: 0,
      startedAt: new Date(harness.now()).toISOString()
    });

    work.resolve(safeResult("one"));
    await flushMicrotasks();
    expect(harness.queue.getJob(enqueued.jobId)).toMatchObject({
      status: "ready",
      progress: 100,
      result: { ...safeResult("one"), processingPreset: "compatible-mp4" },
      completedAt: new Date(harness.now()).toISOString()
    });
  });

  it("starts jobs in FIFO order with concurrency one", async () => {
    const harness = createHarness();
    const starts: string[] = [];
    const work = [deferred<MediaJobResult>(), deferred<MediaJobResult>(), deferred<MediaJobResult>()];

    for (let index = 0; index < work.length; index += 1) {
      harness.queue.enqueue({
        processingPreset: "original",
        handler: (context) => {
          starts.push(context.jobId);
          return work[index].promise;
        }
      });
    }

    await flushMicrotasks();
    expect(starts).toEqual(["job_1"]);
    work[0].resolve(safeResult("first"));
    await flushMicrotasks();
    expect(starts).toEqual(["job_1", "job_2"]);
    work[1].resolve(safeResult("second"));
    await flushMicrotasks();
    expect(starts).toEqual(["job_1", "job_2", "job_3"]);
    work[2].resolve(safeResult("third"));
    await flushMicrotasks();
  });

  it("never exceeds the configured concurrency limit", async () => {
    const harness = createHarness({ maxConcurrentJobs: 2 });
    const work = Array.from({ length: 5 }, () => deferred<MediaJobResult>());
    let active = 0;
    let maximumActive = 0;

    for (let index = 0; index < work.length; index += 1) {
      harness.queue.enqueue({
        processingPreset: "remux-to-mp4",
        handler: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          try {
            return await work[index].promise;
          } finally {
            active -= 1;
          }
        }
      });
    }

    await flushMicrotasks();
    expect(active).toBe(2);
    expect(harness.queue.getStats().runningJobs).toBe(2);
    for (let index = 0; index < work.length; index += 1) {
      work[index].resolve(safeResult(`limit_${index}`));
      await flushMicrotasks();
      expect(harness.queue.getStats().runningJobs).toBeLessThanOrEqual(2);
    }
    expect(maximumActive).toBe(2);
  });

  it("preserves FIFO start order when concurrency is greater than one", async () => {
    const harness = createHarness({ maxConcurrentJobs: 2 });
    const starts: string[] = [];
    const work = [deferred<MediaJobResult>(), deferred<MediaJobResult>(), deferred<MediaJobResult>()];
    for (let index = 0; index < work.length; index += 1) {
      harness.queue.enqueue({
        processingPreset: "audio-only",
        handler: (context) => {
          starts.push(context.jobId);
          return work[index].promise;
        }
      });
    }

    await flushMicrotasks();
    expect(starts).toEqual(["job_1", "job_2"]);
    work[1].resolve(safeResult("parallel_second"));
    await flushMicrotasks();
    expect(starts).toEqual(["job_1", "job_2", "job_3"]);
    work[0].resolve(safeResult("parallel_first"));
    work[2].resolve(safeResult("parallel_third"));
    await flushMicrotasks();
  });

  it("starts the next queued job after a failure", async () => {
    const harness = createHarness();
    const first = deferred<MediaJobResult>();
    const second = deferred<MediaJobResult>();
    const starts: string[] = [];
    const firstJob = harness.queue.enqueue({
      processingPreset: "original",
      handler: (context) => {
        starts.push(context.jobId);
        return first.promise;
      }
    });
    harness.queue.enqueue({
      processingPreset: "original",
      handler: (context) => {
        starts.push(context.jobId);
        return second.promise;
      }
    });

    await flushMicrotasks();
    first.reject(new Error("first failed"));
    await flushMicrotasks();
    expect(harness.queue.getJob(firstJob.jobId).status).toBe("failed");
    expect(starts).toEqual(["job_1", "job_2"]);
    second.resolve(safeResult("after_failure"));
    await flushMicrotasks();
  });

  it("cancels a queued job without invoking its handler", async () => {
    const harness = createHarness();
    const runningWork = deferred<MediaJobResult>();
    const queuedHandler = vi.fn(() => safeResult("never"));
    harness.queue.enqueue({ processingPreset: "original", handler: () => runningWork.promise });
    const queued = harness.queue.enqueue({ processingPreset: "audio-only", handler: queuedHandler });
    await flushMicrotasks();

    const snapshot = await harness.queue.cancelJob(queued.jobId);
    expect(snapshot).toMatchObject({
      status: "cancelled",
      progress: 0,
      error: { code: API_ERROR_CODES.JOB_CANCELLED }
    });
    expect(queuedHandler).not.toHaveBeenCalled();
    runningWork.resolve(safeResult("running"));
    await flushMicrotasks();
  });

  it("aborts a running job, waits for its handler and ignores later progress", async () => {
    const harness = createHarness();
    let receivedSignal: AbortSignal | undefined;
    let updateProgress: ((value: number) => void) | undefined;
    const job = harness.queue.enqueue({
      processingPreset: "compatible-mp4",
      handler: (_context, signal, update) => {
        receivedSignal = signal;
        updateProgress = update;
        return new Promise<MediaJobResult>((resolve) => {
          signal.addEventListener("abort", () => resolve(safeResult("cancelled")), { once: true });
        });
      }
    });
    await flushMicrotasks();
    updateProgress?.(30);

    const snapshot = await harness.queue.cancelJob(job.jobId);
    updateProgress?.(90);
    expect(receivedSignal?.aborted).toBe(true);
    expect(snapshot).toMatchObject({ status: "cancelled", progress: 30 });
    expect(harness.queue.getJob(job.jobId).progress).toBe(30);
  });

  it("cancelling one running job does not affect another", async () => {
    const harness = createHarness({ maxConcurrentJobs: 2 });
    const otherWork = deferred<MediaJobResult>();
    const cancelled = harness.queue.enqueue({
      processingPreset: "remux-to-mp4",
      handler: (_context, signal) => new Promise<MediaJobResult>((resolve) => {
        signal.addEventListener("abort", () => resolve(safeResult("cancel_one")), { once: true });
      })
    });
    const other = harness.queue.enqueue({
      processingPreset: "compatible-mp4",
      handler: () => otherWork.promise
    });
    await flushMicrotasks();

    await harness.queue.cancelJob(cancelled.jobId);
    expect(harness.queue.getJob(cancelled.jobId).status).toBe("cancelled");
    expect(harness.queue.getJob(other.jobId).status).toBe("running");
    otherWork.resolve(safeResult("other"));
    await flushMicrotasks();
    expect(harness.queue.getJob(other.jobId).status).toBe("ready");
  });

  it.each([
    { name: "sync throw", handler: (() => { throw new Error("sync secret"); }) as MediaJobHandler },
    { name: "promise rejection", handler: (() => Promise.reject(new Error("async secret"))) as MediaJobHandler }
  ])("maps handler $name to a sanitized failed snapshot", async ({ handler }) => {
    const harness = createHarness();
    const job = harness.queue.enqueue({ processingPreset: "original", handler });
    await flushMicrotasks();

    expect(harness.queue.getJob(job.jobId)).toMatchObject({
      status: "failed",
      error: {
        code: API_ERROR_CODES.INTERNAL_ERROR,
        message: API_ERROR_MESSAGES.INTERNAL_ERROR
      }
    });
  });

  it("preserves a safe timeout code but discards a handler's custom message", async () => {
    const harness = createHarness();
    const secret = "/private/tmp/video.mp4 stderr -map 0:v";
    const job = harness.queue.enqueue({
      processingPreset: "compatible-mp4",
      handler: () => {
        throw new AppError(API_ERROR_CODES.PROCESSING_TIMEOUT, secret);
      }
    });
    await flushMicrotasks();

    const snapshot = harness.queue.getJob(job.jobId);
    expect(snapshot).toMatchObject({
      status: "failed",
      error: {
        code: API_ERROR_CODES.PROCESSING_TIMEOUT,
        message: API_ERROR_MESSAGES.PROCESSING_TIMEOUT
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it("normalizes progress and never allows it to decrease", async () => {
    const harness = createHarness();
    const work = deferred<MediaJobResult>();
    let update: ((value: number) => void) | undefined;
    const job = harness.queue.enqueue({
      processingPreset: "original",
      handler: (_context, _signal, updateProgress) => {
        update = updateProgress;
        return work.promise;
      }
    });
    await flushMicrotasks();

    update?.(-10);
    expect(harness.queue.getJob(job.jobId).progress).toBe(0);
    update?.(25.5);
    expect(harness.queue.getJob(job.jobId).progress).toBe(25.5);
    update?.(10);
    update?.(Number.NaN);
    expect(harness.queue.getJob(job.jobId).progress).toBe(25.5);
    update?.(150);
    expect(harness.queue.getJob(job.jobId).progress).toBe(100);

    work.resolve(safeResult("progress"));
    await flushMicrotasks();
    update?.(30);
    expect(harness.queue.getJob(job.jobId)).toMatchObject({ status: "ready", progress: 100 });
  });

  it("blocks invalid and duplicate terminal transitions", () => {
    const invalidTransitions: Array<[MediaJobStatus, MediaJobStatus]> = [
      ["ready", "running"],
      ["failed", "ready"],
      ["cancelled", "running"],
      ["ready", "ready"]
    ];

    for (const [from, to] of invalidTransitions) {
      const error = captureAppError(() => assertMediaJobTransition(from, to));
      expect(error.code).toBe(API_ERROR_CODES.INVALID_JOB_STATE);
    }
    expect(() => assertMediaJobTransition("ready", "expired")).not.toThrow();
    expect(() => assertMediaJobTransition("failed", "expired")).not.toThrow();
    expect(() => assertMediaJobTransition("cancelled", "expired")).not.toThrow();
  });

  it("returns JOB_NOT_FOUND for unknown or malformed IDs", async () => {
    const harness = createHarness();
    expect(captureAppError(() => harness.queue.getJob("job_missing")).code).toBe(API_ERROR_CODES.JOB_NOT_FOUND);
    expect(captureAppError(() => harness.queue.getJob("../../secret")).code).toBe(API_ERROR_CODES.JOB_NOT_FOUND);
    const error = await captureAsyncAppError(() => harness.queue.cancelJob("job_missing"));
    expect(error.code).toBe(API_ERROR_CODES.JOB_NOT_FOUND);
  });

  it("rejects enqueue when the bounded waiting queue is full", async () => {
    const harness = createHarness({ maxConcurrentJobs: 1, maxQueuedJobs: 1 });
    const running = deferred<MediaJobResult>();
    harness.queue.enqueue({ processingPreset: "original", handler: () => running.promise });
    await flushMicrotasks();
    harness.queue.enqueue({ processingPreset: "original", handler: () => safeResult("queued") });

    const error = captureAppError(() => {
      harness.queue.enqueue({ processingPreset: "original", handler: () => safeResult("overflow") });
    });
    expect(error.code).toBe(API_ERROR_CODES.QUEUE_FULL);
    expect(harness.queue.getStats().queuedJobs).toBe(1);
    running.resolve(safeResult("capacity_running"));
    await flushMicrotasks();
  });

  it("normalizes invalid or excessive queue configuration safely", () => {
    const invalidValues = [0, -10, Number.NaN, Number.POSITIVE_INFINITY];
    for (const maxConcurrentJobs of invalidValues) {
      const queue = createMediaJobQueue({ maxConcurrentJobs });
      expect(queue.getStats().maxConcurrentJobs).toBeGreaterThanOrEqual(1);
      expect(queue.getStats().maxConcurrentJobs).toBeLessThanOrEqual(MEDIA_JOB_QUEUE_LIMITS.maxConcurrentJobs);
    }

    const excessive = createMediaJobQueue({ maxConcurrentJobs: 10_000, maxQueuedJobs: 100_000 });
    expect(excessive.getStats()).toMatchObject({
      maxConcurrentJobs: MEDIA_JOB_QUEUE_LIMITS.maxConcurrentJobs,
      maxQueuedJobs: MEDIA_JOB_QUEUE_LIMITS.maxQueuedJobs
    });
  });

  it("returns immutable snapshots that cannot mutate internal state", async () => {
    const harness = createHarness();
    const enqueued = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => safeResult("immutable")
    });
    expect(Object.isFrozen(enqueued.snapshot)).toBe(true);
    expect(() => {
      (enqueued.snapshot as { progress: number }).progress = 99;
    }).toThrow();
    expect(harness.queue.getJob(enqueued.jobId).progress).toBe(0);

    await flushMicrotasks();
    const ready = harness.queue.getJob(enqueued.jobId);
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready.result)).toBe(true);
    expect(() => {
      (ready.result as { filename: string }).filename = "/private/secret";
    }).toThrow();
    expect(harness.queue.getJob(enqueued.jobId).result?.filename).toBe("immutable.mp4");
  });

  it("assigns terminal TTL and removes expired terminal jobs", async () => {
    const harness = createHarness({ terminalTtlMs: 1000 });
    const job = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => safeResult("ttl")
    });
    await flushMicrotasks();

    const ready = harness.queue.getJob(job.jobId);
    expect(ready.status).toBe("ready");
    expect(ready.expiresAt).toBe(new Date(harness.now() + 1000).toISOString());
    harness.advanceBy(999);
    expect(harness.queue.cleanupExpiredJobs()).toBe(0);
    harness.advanceBy(1);
    expect(harness.queue.cleanupExpiredJobs()).toBe(1);
    expect(captureAppError(() => harness.queue.getJob(job.jobId)).code).toBe(API_ERROR_CODES.JOB_NOT_FOUND);
  });

  it("never removes queued or running jobs during cleanup", async () => {
    const harness = createHarness({ maxConcurrentJobs: 1, terminalTtlMs: 10 });
    const runningWork = deferred<MediaJobResult>();
    const running = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => runningWork.promise
    });
    const queued = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => safeResult("queued_cleanup")
    });
    await flushMicrotasks();
    harness.advanceBy(100_000);

    expect(harness.queue.cleanupExpiredJobs()).toBe(0);
    expect(harness.queue.getJob(running.jobId).status).toBe("running");
    expect(harness.queue.getJob(queued.jobId).status).toBe("queued");
    runningWork.resolve(safeResult("running_cleanup"));
    await flushMicrotasks();
  });

  it("keeps cancellation authoritative when completion races with abort", async () => {
    const harness = createHarness();
    const work = deferred<MediaJobResult>();
    const job = harness.queue.enqueue({
      processingPreset: "compatible-mp4",
      handler: () => work.promise
    });
    await flushMicrotasks();

    const cancellation = harness.queue.cancelJob(job.jobId);
    work.resolve(safeResult("raced_ready"));
    const cancelled = await cancellation;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toBeUndefined();
    expect(harness.queue.getJob(job.jobId).status).toBe("cancelled");
  });

  it("does not start the next job twice when a thenable completes more than once", async () => {
    const harness = createHarness();
    const secondHandler = vi.fn(() => safeResult("second_once"));
    const duplicateThenable = {
      then(resolve: (result: MediaJobResult) => void) {
        resolve(safeResult("first_resolution"));
        resolve(safeResult("duplicate_resolution"));
      }
    };

    const first = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => duplicateThenable as unknown as Promise<MediaJobResult>
    });
    harness.queue.enqueue({ processingPreset: "original", handler: secondHandler });
    await flushMicrotasks(16);

    expect(harness.queue.getJob(first.jobId).result?.fileId).toBe("file_first_resolution");
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it("returns a stable snapshot when cancelling a terminal job", async () => {
    const harness = createHarness();
    const job = harness.queue.enqueue({
      processingPreset: "audio-only",
      handler: () => safeResult("terminal")
    });
    await flushMicrotasks();
    const before = harness.queue.getJob(job.jobId);
    const after = await harness.queue.cancelJob(job.jobId);
    expect(before.status).toBe("ready");
    expect(after).toEqual(before);
  });

  it("rejects unsafe handler results without exposing paths", async () => {
    const harness = createHarness();
    const secretPath = "/private/tmp/output.mp4";
    const job = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => ({
        ...safeResult("unsafe"),
        filename: secretPath,
        downloadUrl: `file://${secretPath}`
      })
    });
    await flushMicrotasks();

    const snapshot = harness.queue.getJob(job.jobId);
    expect(snapshot).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.INTERNAL_ERROR }
    });
    expect(JSON.stringify(snapshot)).not.toContain(secretPath);
  });

  it("handles rejected handlers without unhandled promise rejections", async () => {
    const harness = createHarness();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);

    try {
      const job = harness.queue.enqueue({
        processingPreset: "original",
        handler: () => Promise.reject(new Error("handled rejection"))
      });
      await flushMicrotasks(16);
      expect(harness.queue.getJob(job.jobId).status).toBe("failed");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("provides only safe immutable context to handlers", async () => {
    const harness = createHarness();
    let receivedContext: object | undefined;
    const job = harness.queue.enqueue({
      processingPreset: "remux-to-mp4",
      handler: (context) => {
        receivedContext = context;
        return safeResult("context");
      }
    });
    await flushMicrotasks();

    expect(receivedContext).toEqual({
      jobId: job.jobId,
      processingPreset: "remux-to-mp4",
      createdAt: new Date(harness.now()).toISOString()
    });
    expect(Object.isFrozen(receivedContext)).toBe(true);
    expect(Object.keys(receivedContext ?? {})).toEqual(["jobId", "processingPreset", "createdAt"]);
  });

  it("maps a handler cancellation error to cancelled and keeps processing", async () => {
    const harness = createHarness();
    const cancelled = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => {
        throw new AppError(API_ERROR_CODES.JOB_CANCELLED, "/private/cancelled");
      }
    });
    const next = harness.queue.enqueue({
      processingPreset: "original",
      handler: () => safeResult("after_cancel_error")
    });
    await flushMicrotasks(16);

    expect(harness.queue.getJob(cancelled.jobId)).toMatchObject({
      status: "cancelled",
      error: { message: API_ERROR_MESSAGES.JOB_CANCELLED }
    });
    expect(harness.queue.getJob(next.jobId).status).toBe("ready");
  });

  it("listJobs returns frozen snapshots without exposing internal controllers or handlers", async () => {
    const harness = createHarness();
    const work = deferred<MediaJobResult>();
    harness.queue.enqueue({ processingPreset: "original", handler: () => work.promise });
    await flushMicrotasks();

    const snapshots = harness.queue.listJobs();
    expect(Object.isFrozen(snapshots)).toBe(true);
    expect(Object.isFrozen(snapshots[0])).toBe(true);
    expect(snapshots[0]).not.toHaveProperty("handler");
    expect(snapshots[0]).not.toHaveProperty("controller");
    expect(snapshots[0]).not.toHaveProperty("signal");
    work.resolve(safeResult("listed"));
    await flushMicrotasks();
  });
});
