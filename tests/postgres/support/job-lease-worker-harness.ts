import { API_ERROR_CODES } from "@/lib/types";
import {
  createJobWorkerId,
  sanitizeMediaJobWorkItem,
  type ClaimedMediaJob,
  type JobLeaseQueue,
  type JobLeaseRef,
  type OwnedJobCompletion,
  type OwnedJobUpdateResult
} from "@/lib/jobs/job-lease-queue";

export type TestJobProcessorContext = Readonly<{
  job: ClaimedMediaJob;
  signal: AbortSignal;
  updateProgress: (progress: number) => Promise<void>;
}>;

export type TestJobProcessor = (
  context: TestJobProcessorContext
) => Promise<OwnedJobCompletion>;

export type TestJobLeaseWorkerHarnessOptions = Readonly<{
  queue: JobLeaseQueue;
  concurrency: number;
  renewalIntervalMs: number;
  recoveryIntervalMs: number;
  processor: TestJobProcessor;
}>;

function positiveBoundedInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("Test worker execution was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Integration-only worker loop. It owns no production wiring and never runs
 * extractors, network requests, ffmpeg, or ffprobe.
 */
export function createTestJobLeaseWorkerHarness(
  options: TestJobLeaseWorkerHarnessOptions
) {
  if (!options?.queue || typeof options.queue.claimNext !== "function") {
    throw new TypeError("Test worker harness requires a job lease queue.");
  }
  const concurrency = positiveBoundedInteger("Test worker concurrency", options.concurrency, 32);
  const renewalIntervalMs = positiveBoundedInteger(
    "Test worker renewal interval",
    options.renewalIntervalMs,
    300_000
  );
  const recoveryIntervalMs = positiveBoundedInteger(
    "Test worker recovery interval",
    options.recoveryIntervalMs,
    300_000
  );
  if (typeof options.processor !== "function") {
    throw new TypeError("Test worker harness requires a processor.");
  }

  let stopped = false;
  let runPromise: Promise<void> | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;
  const heartbeatTimers = new Set<ReturnType<typeof setInterval>>();
  const controllers = new Set<AbortController>();
  const pendingRecovery = new Set<Promise<unknown>>();

  function scheduleRecovery(): void {
    const operation = options.queue.recoverExpiredLeases().catch(() => undefined);
    pendingRecovery.add(operation);
    void operation.finally(() => pendingRecovery.delete(operation));
  }

  async function processClaim(claimed: ClaimedMediaJob): Promise<void> {
    // This repeats payload and URL/SSRF validation immediately before execution.
    sanitizeMediaJobWorkItem(claimed.workItem);
    const controller = new AbortController();
    controllers.add(controller);
    let lease: JobLeaseRef = claimed.lease;
    let mutationChain: Promise<void> = Promise.resolve();

    const applyOwnedUpdate = (
      operation: (current: JobLeaseRef) => Promise<OwnedJobUpdateResult>
    ): Promise<void> => {
      const next = mutationChain.then(async () => {
        if (controller.signal.aborted) throw abortError();
        const result = await operation(lease);
        if (result.outcome !== "updated") {
          controller.abort();
          throw abortError();
        }
        lease = result.lease;
      });
      mutationChain = next.catch(() => undefined);
      return next;
    };

    const heartbeat = setInterval(() => {
      void applyOwnedUpdate((current) => options.queue.renewLease(current)).catch(() => undefined);
    }, renewalIntervalMs);
    heartbeatTimers.add(heartbeat);

    const stopHeartbeat = () => {
      clearInterval(heartbeat);
      heartbeatTimers.delete(heartbeat);
    };

    try {
      const completion = await options.processor({
        job: claimed,
        signal: controller.signal,
        updateProgress(progress) {
          return applyOwnedUpdate((current) =>
            options.queue.updateProgressOwned(current, progress)
          );
        }
      });
      stopHeartbeat();
      await mutationChain;
      if (controller.signal.aborted) throw abortError();
      const completed = await options.queue.completeOwned(lease, completion);
      if (completed.outcome !== "completed" && completed.outcome !== "already-completed") {
        controller.abort();
      }
    } catch (error) {
      stopHeartbeat();
      if (!controller.signal.aborted && (error as Error)?.name !== "AbortError") {
        await mutationChain;
        const completed = await options.queue.completeOwned(lease, {
          type: "failed",
          errorCode: API_ERROR_CODES.PROCESSING_FAILED
        });
        if (completed.outcome !== "completed" && completed.outcome !== "already-completed") {
          controller.abort();
        }
      }
    } finally {
      stopHeartbeat();
      controllers.delete(controller);
    }
  }

  async function workerLoop(workerId: string): Promise<void> {
    while (!stopped) {
      const claimed = await options.queue.claimNext(workerId);
      if (claimed.outcome === "empty") return;
      await processClaim(claimed.job);
    }
  }

  async function runUntilIdle(): Promise<void> {
    if (runPromise) throw new TypeError("Test worker harness is already running.");
    stopped = false;
    recoveryTimer = setInterval(scheduleRecovery, recoveryIntervalMs);
    runPromise = Promise.all(
      Array.from({ length: concurrency }, () => workerLoop(createJobWorkerId()))
    ).then(() => undefined);
    try {
      await runPromise;
    } finally {
      if (recoveryTimer) clearInterval(recoveryTimer);
      recoveryTimer = null;
      runPromise = null;
      await Promise.all([...pendingRecovery]);
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (recoveryTimer) clearInterval(recoveryTimer);
    recoveryTimer = null;
    for (const timer of heartbeatTimers) clearInterval(timer);
    heartbeatTimers.clear();
    for (const controller of controllers) controller.abort();
    await runPromise?.catch(() => undefined);
    await Promise.all([...pendingRecovery]);
  }

  return Object.freeze({ runUntilIdle, stop });
}
