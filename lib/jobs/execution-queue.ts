import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const DEFAULT_MAX_QUEUED_JOBS = 100;
const MAX_CONCURRENT_JOBS_LIMIT = 8;
const MAX_QUEUED_JOBS_LIMIT = 1000;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export const LOCAL_JOB_EXECUTION_LIMITS = Object.freeze({
  maxConcurrentJobs: MAX_CONCURRENT_JOBS_LIMIT,
  maxQueuedJobs: MAX_QUEUED_JOBS_LIMIT
});

export type LocalJobExecutionQueueStats = Readonly<{
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  runningJobs: number;
  queuedJobs: number;
  totalExecutions: number;
}>;

export type LocalJobExecution = Readonly<{
  jobId: string;
  execute: (signal: AbortSignal) => void | Promise<void>;
  onCancelledBeforeStart?: () => void | Promise<void>;
}>;

export type LocalJobCancellationResult = "queued" | "running" | "not-found";

/**
 * Process-local scheduling only. Implementations must not store job status,
 * progress, result, canonical error or cancellation timestamps.
 */
export interface JobExecutionQueue {
  enqueue(execution: LocalJobExecution): void;
  cancel(jobId: string): Promise<LocalJobCancellationResult>;
  getStats(): LocalJobExecutionQueueStats;
}

export type CreateLocalJobExecutionQueueOptions = Readonly<{
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
}>;

type EphemeralExecution = {
  execute?: LocalJobExecution["execute"];
  onCancelledBeforeStart?: LocalJobExecution["onCancelledBeforeStart"];
  controller?: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
};

function normalizeBoundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value as number)));
}

export function createLocalJobExecutionQueue(
  options: CreateLocalJobExecutionQueueOptions = {}
): JobExecutionQueue {
  const maxConcurrentJobs = normalizeBoundedInteger(
    options.maxConcurrentJobs,
    DEFAULT_MAX_CONCURRENT_JOBS,
    MAX_CONCURRENT_JOBS_LIMIT
  );
  const maxQueuedJobs = normalizeBoundedInteger(
    options.maxQueuedJobs,
    DEFAULT_MAX_QUEUED_JOBS,
    MAX_QUEUED_JOBS_LIMIT
  );
  const executions = new Map<string, EphemeralExecution>();
  const pendingJobIds: string[] = [];
  let runningJobs = 0;
  let drainScheduled = false;

  function finish(jobId: string, execution: EphemeralExecution): void {
    execution.controller = undefined;
    execution.execute = undefined;
    execution.onCancelledBeforeStart = undefined;
    executions.delete(jobId);
    execution.resolveSettled();
    runningJobs = Math.max(0, runningJobs - 1);
    scheduleDrain();
  }

  function start(jobId: string, execution: EphemeralExecution): void {
    const handler = execution.execute;
    if (!handler) {
      executions.delete(jobId);
      execution.resolveSettled();
      return;
    }

    runningJobs += 1;
    const controller = new AbortController();
    execution.controller = controller;
    void Promise.resolve()
      .then(() => handler(controller.signal))
      .catch(() => undefined)
      .finally(() => finish(jobId, execution));
  }

  function drain(): void {
    while (runningJobs < maxConcurrentJobs && pendingJobIds.length > 0) {
      const jobId = pendingJobIds.shift();
      if (!jobId) continue;
      const execution = executions.get(jobId);
      if (!execution || execution.controller) continue;
      start(jobId, execution);
    }
  }

  function scheduleDrain(): void {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      drain();
    });
  }

  function enqueue(input: LocalJobExecution): void {
    if (
      !input ||
      typeof input.jobId !== "string" ||
      !SAFE_JOB_ID.test(input.jobId) ||
      typeof input.execute !== "function"
    ) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
    }
    if (executions.has(input.jobId)) throw new AppError(API_ERROR_CODES.INVALID_JOB_STATE);
    if (pendingJobIds.length >= maxQueuedJobs) throw new AppError(API_ERROR_CODES.QUEUE_FULL);

    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    executions.set(input.jobId, {
      execute: input.execute,
      onCancelledBeforeStart: input.onCancelledBeforeStart,
      settled,
      resolveSettled
    });
    pendingJobIds.push(input.jobId);
    scheduleDrain();
  }

  async function cancel(jobId: string): Promise<LocalJobCancellationResult> {
    const execution = executions.get(jobId);
    if (!execution) return "not-found";

    if (!execution.controller) {
      const pendingIndex = pendingJobIds.indexOf(jobId);
      if (pendingIndex >= 0) pendingJobIds.splice(pendingIndex, 1);
      executions.delete(jobId);
      const onCancelledBeforeStart = execution.onCancelledBeforeStart;
      execution.execute = undefined;
      execution.onCancelledBeforeStart = undefined;
      try {
        await onCancelledBeforeStart?.();
      } catch {
        // Cleanup remains best effort and cannot replace authoritative cancellation.
      } finally {
        execution.resolveSettled();
      }
      scheduleDrain();
      return "queued";
    }

    execution.controller.abort();
    await execution.settled;
    return "running";
  }

  function getStats(): LocalJobExecutionQueueStats {
    return Object.freeze({
      maxConcurrentJobs,
      maxQueuedJobs,
      runningJobs,
      queuedJobs: pendingJobIds.length,
      totalExecutions: executions.size
    });
  }

  return Object.freeze({ enqueue, cancel, getStats });
}
