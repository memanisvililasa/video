import { env } from "@/lib/config/env";
import {
  createLocalJobExecutionQueue,
  LOCAL_JOB_EXECUTION_LIMITS,
  type JobExecutionQueue
} from "@/lib/jobs/execution-queue";
import {
  createInMemoryJobRepository,
  type InMemoryJobRepository
} from "@/lib/jobs/in-memory-job-repository";
import { assertMediaJobTransition } from "@/lib/jobs/job-record";
import type { JobRepository } from "@/lib/jobs/repository";
import {
  createMediaJobRuntime,
  type MediaJobRuntime
} from "@/lib/jobs/runtime";

export type {
  EnqueuedMediaJob,
  EnqueueMediaJobOptions,
  MediaJob,
  MediaJobContext,
  MediaJobFailure,
  MediaJobDiscardHandler,
  MediaJobHandler,
  MediaJobOutputMetadata,
  MediaJobProgressUpdater,
  MediaJobQueueStats,
  MediaJobRecord,
  MediaJobResult,
  MediaJobSnapshot,
  MediaJobSourceMetadata,
  MediaJobStatus
} from "@/lib/jobs/types";
export type { JobExecutionQueue } from "@/lib/jobs/execution-queue";
export type { JobRepository } from "@/lib/jobs/repository";
export { assertMediaJobTransition };

const MAX_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MEDIA_JOB_QUEUE_LIMITS = Object.freeze({
  maxConcurrentJobs: LOCAL_JOB_EXECUTION_LIMITS.maxConcurrentJobs,
  maxQueuedJobs: LOCAL_JOB_EXECUTION_LIMITS.maxQueuedJobs,
  maxTerminalTtlMs: MAX_TERMINAL_TTL_MS
});

export type CreateMediaJobQueueOptions = Readonly<{
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
  terminalTtlMs?: number;
  now?: () => number;
  createJobId?: () => string;
  jobRepository?: JobRepository;
  executionQueue?: JobExecutionQueue;
}>;

/**
 * Compatibility name retained for callers while persistence and scheduling are
 * separate ports. The repository is the only authoritative job-state source.
 */
export type MediaJobQueue = MediaJobRuntime;

export type InMemoryMediaJobRuntime = MediaJobRuntime & Readonly<{
  jobRepository: JobRepository | InMemoryJobRepository;
}>;

export function createMediaJobQueue(
  options: CreateMediaJobQueueOptions = {}
): InMemoryMediaJobRuntime {
  const jobRepository =
    options.jobRepository ??
    createInMemoryJobRepository({
      terminalTtlMs: options.terminalTtlMs,
      now: options.now
    });
  const executionQueue =
    options.executionQueue ??
    createLocalJobExecutionQueue({
      maxConcurrentJobs: options.maxConcurrentJobs,
      maxQueuedJobs: options.maxQueuedJobs
    });

  return createMediaJobRuntime({
    jobRepository,
    executionQueue,
    createJobId: options.createJobId
  });
}

type MediaJobRuntimeGlobal = typeof globalThis & {
  __videoSaveMediaJobRuntimeV2?: InMemoryMediaJobRuntime;
  __videoSaveMediaJobRuntimeWarningV2?: boolean;
};

const runtimeGlobal = globalThis as MediaJobRuntimeGlobal;

function getSingletonRuntime(): InMemoryMediaJobRuntime {
  if (!runtimeGlobal.__videoSaveMediaJobRuntimeV2) {
    runtimeGlobal.__videoSaveMediaJobRuntimeV2 = createMediaJobQueue({
      maxConcurrentJobs: env.maxConcurrentJobs,
      maxQueuedJobs: env.maxQueuedJobs,
      terminalTtlMs: env.tempFileTtlMinutes * 60 * 1000
    });
  }

  if (env.nodeEnv === "production" && !runtimeGlobal.__videoSaveMediaJobRuntimeWarningV2) {
    console.warn(
      "[VideoSave] The in-memory media job repository and local execution queue are ephemeral and support only one application instance."
    );
    runtimeGlobal.__videoSaveMediaJobRuntimeWarningV2 = true;
  }

  return runtimeGlobal.__videoSaveMediaJobRuntimeV2;
}

/** Shared single-process composition root used by the existing API facade. */
export const mediaJobRuntime = getSingletonRuntime();

/** @deprecated Compatibility alias; use mediaJobRuntime for new internal code. */
export const mediaJobQueue = mediaJobRuntime;
export const enqueueMediaJob = mediaJobRuntime.enqueue;
export const enqueueJob = enqueueMediaJob;
export const getJob = mediaJobRuntime.getJob;
export const cancelJob = mediaJobRuntime.cancelJob;
export const cleanupExpiredJobs = mediaJobRuntime.cleanupExpiredJobs;

/** @internal Intended for tests and single-process administration only. */
export const listJobs = mediaJobRuntime.listJobs;
