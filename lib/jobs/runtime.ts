import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";
import type { JobExecutionQueue } from "@/lib/jobs/execution-queue";
import { mediaJobRecordToSnapshot, type MediaJobMutation, type MediaJobSourceMetadataInput } from "@/lib/jobs/job-record";
import type {
  JobRepository,
  JobRepositoryCancellationResult,
  JobRepositoryUpdateResult
} from "@/lib/jobs/repository";
import type {
  EnqueuedMediaJob,
  EnqueueMediaJobOptions,
  MediaJobContext,
  MediaJobDiscardHandler,
  MediaJobQueueStats,
  MediaJobSnapshot
} from "@/lib/jobs/types";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const VALID_PROCESSING_PRESETS = new Set<ProcessingPreset>([
  "original",
  "remux-to-mp4",
  "compatible-mp4",
  "audio-only"
]);
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_CONCURRENT_WRITE_ATTEMPTS = 16;

export type CreateMediaJobRuntimeOptions = Readonly<{
  jobRepository: JobRepository;
  executionQueue: JobExecutionQueue;
  createJobId?: () => string;
}>;

export interface MediaJobRuntime {
  readonly jobRepository: JobRepository;
  readonly executionQueue: JobExecutionQueue;
  enqueue(options: EnqueueMediaJobOptions): Promise<EnqueuedMediaJob>;
  getJob(jobId: string): Promise<MediaJobSnapshot>;
  cancelJob(jobId: string): Promise<MediaJobSnapshot>;
  setSourceMetadata(jobId: string, sourceMetadata: MediaJobSourceMetadataInput): Promise<void>;
  cleanupExpiredJobs(nowMs?: number): Promise<number>;
  listJobs(): Promise<readonly MediaJobSnapshot[]>;
  getStats(): Promise<MediaJobQueueStats>;
}

function compactJobId(): string {
  return `job_${randomUUID().replaceAll("-", "")}`;
}

function requireSafeJobId(jobId: string): void {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) {
    throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
  }
}

function handlerFailureCode(error: unknown): ApiErrorCode {
  return error instanceof AppError ? error.code : API_ERROR_CODES.INTERNAL_ERROR;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isCancellationError(error: unknown): boolean {
  return (error instanceof AppError && error.code === API_ERROR_CODES.JOB_CANCELLED) || isAbortError(error);
}

function processingPresetIsValid(value: unknown): value is ProcessingPreset {
  return typeof value === "string" && VALID_PROCESSING_PRESETS.has(value as ProcessingPreset);
}

export function createMediaJobRuntime(options: CreateMediaJobRuntimeOptions): MediaJobRuntime {
  const jobRepository = options.jobRepository;
  const executionQueue = options.executionQueue;
  const createJobId = options.createJobId ?? compactJobId;
  const progressFlushes = new Map<string, Promise<void>>();
  let enqueueTail: Promise<void> = Promise.resolve();

  if (!jobRepository || !executionQueue) {
    throw new TypeError("Media job runtime requires a repository and an execution queue.");
  }

  function serializeEnqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = enqueueTail;
    let release!: () => void;
    enqueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }

  async function requireRecord(jobId: string) {
    requireSafeJobId(jobId);
    const record = await jobRepository.get(jobId);
    if (!record) throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
    return record;
  }

  async function updateWithRetry(
    jobId: string,
    mutation: MediaJobMutation
  ): Promise<JobRepositoryUpdateResult> {
    for (let attempt = 0; attempt < MAX_CONCURRENT_WRITE_ATTEMPTS; attempt += 1) {
      const current = await jobRepository.get(jobId);
      if (!current) return Object.freeze({ outcome: "not-found" });
      const result = await jobRepository.update(jobId, current.version, mutation);
      if (result.outcome !== "version-conflict") return result;
    }
    const current = await jobRepository.get(jobId);
    return current
      ? Object.freeze({ outcome: "version-conflict", record: current })
      : Object.freeze({ outcome: "not-found" });
  }

  async function requestCancellationWithRetry(jobId: string): Promise<JobRepositoryCancellationResult> {
    for (let attempt = 0; attempt < MAX_CONCURRENT_WRITE_ATTEMPTS; attempt += 1) {
      const current = await jobRepository.get(jobId);
      if (!current) return Object.freeze({ outcome: "not-found" });
      const result = await jobRepository.requestCancellation(jobId, current.version);
      if (result.outcome !== "version-conflict") return result;
    }
    const current = await jobRepository.get(jobId);
    return current
      ? Object.freeze({ outcome: "version-conflict", record: current })
      : Object.freeze({ outcome: "not-found" });
  }

  async function failRunningJob(jobId: string, errorCode: ApiErrorCode): Promise<void> {
    const result = await updateWithRetry(jobId, { type: "fail", errorCode });
    if (result.outcome === "not-found") return;
    if (result.outcome === "version-conflict") {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
    }
  }

  async function cancelRecord(jobId: string): Promise<void> {
    const result = await requestCancellationWithRetry(jobId);
    if (result.outcome === "version-conflict") throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
  }

  function enqueue(enqueueOptions: EnqueueMediaJobOptions): Promise<EnqueuedMediaJob> {
    if (
      !enqueueOptions ||
      !processingPresetIsValid(enqueueOptions.processingPreset) ||
      typeof enqueueOptions.handler !== "function"
    ) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
    }

    return serializeEnqueue(async () => {
      await jobRepository.cleanupExpired();
      const schedulerStats = executionQueue.getStats();
      if (schedulerStats.queuedJobs >= schedulerStats.maxQueuedJobs) {
        throw new AppError(API_ERROR_CODES.QUEUE_FULL);
      }

      let created;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = createJobId();
        if (typeof candidate !== "string" || !SAFE_JOB_ID.test(candidate)) continue;
        const result = await jobRepository.create({
          jobId: candidate,
          processingPreset: enqueueOptions.processingPreset
        });
        if (result.outcome === "created") {
          created = result.record;
          break;
        }
        if (result.outcome === "invalid-state") throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
      }
      if (!created) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);

      const jobId = created.jobId;
      let discardInvoked = false;
      let progressWrites: Promise<void> = Promise.resolve();

      const discardOnce = async (handler: MediaJobDiscardHandler | undefined): Promise<void> => {
        if (discardInvoked) return;
        discardInvoked = true;
        try {
          await handler?.();
        } catch {
          // Cleanup is best effort and cannot replace authoritative job state.
        }
      };

      const updateProgress = (value: number): void => {
        if (!Number.isFinite(value)) return;
        const normalized = Math.min(100, Math.max(0, value));
        progressWrites = progressWrites
          .then(async () => {
            const result = await updateWithRetry(jobId, { type: "progress", progress: normalized });
            if (result.outcome === "version-conflict") {
              throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
            }
          })
          .catch(() => undefined);
        progressFlushes.set(jobId, progressWrites);
      };

      const execute = async (signal: AbortSignal): Promise<void> => {
        try {
          const started = await updateWithRetry(jobId, { type: "start" });
          if (started.outcome !== "updated") {
            await discardOnce(enqueueOptions.onDiscard);
            return;
          }

          const context: MediaJobContext = Object.freeze({
            jobId,
            processingPreset: started.record.processingPreset,
            createdAt: started.record.createdAt
          });

          try {
            const result = await enqueueOptions.handler(context, signal, updateProgress);
            await progressWrites;

            if (signal.aborted) {
              await cancelRecord(jobId);
              await discardOnce(enqueueOptions.onDiscard);
              return;
            }

            const completion = await updateWithRetry(jobId, { type: "complete", result });
            if (completion.outcome === "updated") return;

            await discardOnce(enqueueOptions.onDiscard);
            if (completion.outcome === "invalid-state" && completion.record.status === "running") {
              await failRunningJob(jobId, API_ERROR_CODES.INTERNAL_ERROR);
            }
          } catch (error) {
            await progressWrites;
            await discardOnce(enqueueOptions.onDiscard);
            if (signal.aborted || isCancellationError(error)) {
              await cancelRecord(jobId);
              return;
            }
            await failRunningJob(jobId, handlerFailureCode(error));
          }
        } finally {
          progressFlushes.delete(jobId);
        }
      };

      try {
        executionQueue.enqueue({
          jobId,
          execute,
          onCancelledBeforeStart: () => discardOnce(enqueueOptions.onDiscard)
        });
      } catch (error) {
        await cancelRecord(jobId);
        throw error;
      }

      return Object.freeze({ jobId, snapshot: mediaJobRecordToSnapshot(created) });
    });
  }

  async function getJob(jobId: string): Promise<MediaJobSnapshot> {
    return mediaJobRecordToSnapshot(await requireRecord(jobId));
  }

  async function cancelJob(jobId: string): Promise<MediaJobSnapshot> {
    requireSafeJobId(jobId);
    await progressFlushes.get(jobId);
    const cancellation = await requestCancellationWithRetry(jobId);
    if (cancellation.outcome === "not-found") throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
    if (cancellation.outcome === "version-conflict") throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);

    if (cancellation.outcome === "updated") {
      await executionQueue.cancel(jobId);
      return mediaJobRecordToSnapshot(await requireRecord(jobId));
    }

    return mediaJobRecordToSnapshot(cancellation.record);
  }

  async function setSourceMetadata(
    jobId: string,
    sourceMetadata: MediaJobSourceMetadataInput
  ): Promise<void> {
    const result = await updateWithRetry(jobId, { type: "set-source-metadata", sourceMetadata });
    if (result.outcome === "not-found") throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
    if (result.outcome === "version-conflict") throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
    if (result.outcome === "invalid-state") {
      throw new AppError(
        result.record.status === "cancelled"
          ? API_ERROR_CODES.JOB_CANCELLED
          : API_ERROR_CODES.INVALID_JOB_STATE
      );
    }
  }

  function cleanupExpiredJobs(nowMs?: number): Promise<number> {
    return jobRepository.cleanupExpired(nowMs);
  }

  async function listJobs(): Promise<readonly MediaJobSnapshot[]> {
    const records = await jobRepository.list();
    return Object.freeze(records.map(mediaJobRecordToSnapshot));
  }

  async function getStats(): Promise<MediaJobQueueStats> {
    const [records, schedulerStats] = await Promise.all([
      jobRepository.list(),
      Promise.resolve(executionQueue.getStats())
    ]);
    return Object.freeze({
      maxConcurrentJobs: schedulerStats.maxConcurrentJobs,
      maxQueuedJobs: schedulerStats.maxQueuedJobs,
      runningJobs: schedulerStats.runningJobs,
      queuedJobs: schedulerStats.queuedJobs,
      totalJobs: records.length
    });
  }

  return Object.freeze({
    jobRepository,
    executionQueue,
    enqueue,
    getJob,
    cancelJob,
    setSourceMetadata,
    cleanupExpiredJobs,
    listJobs,
    getStats
  });
}
