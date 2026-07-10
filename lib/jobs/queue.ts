import { randomUUID } from "node:crypto";
import { env } from "@/lib/config/env";
import { API_ERROR_MESSAGES, AppError } from "@/lib/errors";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";
import type {
  EnqueuedMediaJob,
  EnqueueMediaJobOptions,
  MediaJob,
  MediaJobContext,
  MediaJobFailure,
  MediaJobHandler,
  MediaJobQueueStats,
  MediaJobResult,
  MediaJobSnapshot,
  MediaJobStatus
} from "@/lib/jobs/types";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

export type {
  EnqueuedMediaJob,
  EnqueueMediaJobOptions,
  MediaJob,
  MediaJobContext,
  MediaJobFailure,
  MediaJobHandler,
  MediaJobProgressUpdater,
  MediaJobQueueStats,
  MediaJobResult,
  MediaJobSnapshot,
  MediaJobStatus
} from "@/lib/jobs/types";

const DEFAULT_MAX_CONCURRENT_JOBS = 2;
const DEFAULT_MAX_QUEUED_JOBS = 100;
const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT_JOBS_LIMIT = 8;
const MAX_QUEUED_JOBS_LIMIT = 1000;
const MAX_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_FILE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const VALID_PROCESSING_PRESETS = new Set<ProcessingPreset>([
  "original",
  "remux-to-mp4",
  "compatible-mp4",
  "audio-only"
]);
const TERMINAL_STATUSES = new Set<MediaJobStatus>(["ready", "failed", "cancelled"]);

const ALLOWED_TRANSITIONS: Readonly<Record<MediaJobStatus, ReadonlySet<MediaJobStatus>>> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["ready", "failed", "cancelled"]),
  ready: new Set(["expired"]),
  failed: new Set(["expired"]),
  cancelled: new Set(["expired"]),
  expired: new Set()
};

export const MEDIA_JOB_QUEUE_LIMITS = Object.freeze({
  maxConcurrentJobs: MAX_CONCURRENT_JOBS_LIMIT,
  maxQueuedJobs: MAX_QUEUED_JOBS_LIMIT,
  maxTerminalTtlMs: MAX_TERMINAL_TTL_MS
});

export type CreateMediaJobQueueOptions = {
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
  terminalTtlMs?: number;
  now?: () => number;
  createJobId?: () => string;
};

export type MediaJobQueue = {
  enqueue: (options: EnqueueMediaJobOptions) => EnqueuedMediaJob;
  getJob: (jobId: string) => MediaJobSnapshot;
  cancelJob: (jobId: string) => Promise<MediaJobSnapshot>;
  cleanupExpiredJobs: (nowMs?: number) => number;
  listJobs: () => readonly MediaJobSnapshot[];
  getStats: () => MediaJobQueueStats;
};

type InternalMediaJob = {
  job: MediaJob;
  handler?: MediaJobHandler;
  controller?: AbortController;
  cancelRequested: boolean;
  expiresAtMs?: number;
  settled: Promise<void>;
  resolveSettled?: () => void;
};

function normalizeBoundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value as number)));
}

function normalizeTerminalTtl(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_TTL_MS;
  return Math.min(MAX_TERMINAL_TTL_MS, Math.max(0, Math.trunc(value as number)));
}

function isoTimestamp(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Media job clock must return a finite timestamp.");
  return new Date(value).toISOString();
}

function processingPresetIsValid(value: unknown): value is ProcessingPreset {
  return typeof value === "string" && VALID_PROCESSING_PRESETS.has(value as ProcessingPreset);
}

function safeFailure(code: ApiErrorCode): MediaJobFailure {
  return Object.freeze({ code, message: API_ERROR_MESSAGES[code] });
}

function handlerFailure(error: unknown): MediaJobFailure {
  if (error instanceof AppError) return safeFailure(error.code);
  return safeFailure(API_ERROR_CODES.INTERNAL_ERROR);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isCancellationError(error: unknown): boolean {
  return (error instanceof AppError && error.code === API_ERROR_CODES.JOB_CANCELLED) || isAbortError(error);
}

function sanitizeJobResult(value: unknown): MediaJobResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Media job result is invalid.");
  }

  const result = value as Partial<MediaJobResult>;
  if (
    typeof result.fileId !== "string" ||
    !SAFE_FILE_ID.test(result.fileId) ||
    result.downloadUrl !== `/api/file/${result.fileId}` ||
    typeof result.filename !== "string" ||
    !result.filename ||
    result.filename.length > 180 ||
    result.filename.includes("/") ||
    result.filename.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(result.filename) ||
    !Number.isSafeInteger(result.sizeBytes) ||
    (result.sizeBytes as number) <= 0 ||
    typeof result.contentType !== "string" ||
    !SAFE_CONTENT_TYPE.test(result.contentType)
  ) {
    throw new TypeError("Media job result is invalid.");
  }

  return Object.freeze({
    fileId: result.fileId,
    downloadUrl: result.downloadUrl,
    filename: result.filename,
    sizeBytes: result.sizeBytes,
    contentType: result.contentType
  }) as MediaJobResult;
}

function immutableSnapshot(job: MediaJob): MediaJobSnapshot {
  const result = job.result ? Object.freeze({ ...job.result }) : undefined;
  const error = job.error ? Object.freeze({ ...job.error }) : undefined;
  return Object.freeze({
    jobId: job.jobId,
    status: job.status,
    processingPreset: job.processingPreset,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
    progress: job.progress,
    ...(result ? { result } : {}),
    ...(error ? { error } : {})
  });
}

function requireSafeJobId(jobId: string): void {
  if (typeof jobId !== "string" || !SAFE_JOB_ID.test(jobId)) {
    throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
  }
}

/** @internal Exported for explicit state-machine tests. */
export function assertMediaJobTransition(from: MediaJobStatus, to: MediaJobStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.has(to)) {
    throw new AppError(API_ERROR_CODES.INVALID_JOB_STATE);
  }
}

export function createMediaJobQueue(options: CreateMediaJobQueueOptions = {}): MediaJobQueue {
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
  const terminalTtlMs = normalizeTerminalTtl(options.terminalTtlMs);
  const now = options.now ?? Date.now;
  const createJobId = options.createJobId ?? (() => `job_${randomUUID().replaceAll("-", "")}`);
  const jobs = new Map<string, InternalMediaJob>();
  const pendingJobIds: string[] = [];
  let runningJobs = 0;
  let drainScheduled = false;

  function currentTime(): number {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError("Media job clock must return a finite timestamp.");
    return value;
  }

  function requireJob(jobId: string): InternalMediaJob {
    requireSafeJobId(jobId);
    const record = jobs.get(jobId);
    if (!record) throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
    return record;
  }

  function uniqueJobId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = createJobId();
      if (typeof candidate === "string" && SAFE_JOB_ID.test(candidate) && !jobs.has(candidate)) return candidate;
    }
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
  }

  function transition(record: InternalMediaJob, nextStatus: MediaJobStatus, timestamp = currentTime()): void {
    assertMediaJobTransition(record.job.status, nextStatus);
    record.job.status = nextStatus;

    if (nextStatus === "running") {
      record.job.startedAt = isoTimestamp(timestamp);
      return;
    }

    if (TERMINAL_STATUSES.has(nextStatus)) {
      record.job.completedAt = isoTimestamp(timestamp);
      record.expiresAtMs = timestamp + terminalTtlMs;
      record.job.expiresAt = isoTimestamp(record.expiresAtMs);
      record.handler = undefined;
      record.resolveSettled?.();
      record.resolveSettled = undefined;
    }
  }

  function transitionToCancelled(record: InternalMediaJob): void {
    if (record.job.status !== "queued" && record.job.status !== "running") return;
    record.job.error = safeFailure(API_ERROR_CODES.JOB_CANCELLED);
    transition(record, "cancelled");
  }

  function updateProgress(record: InternalMediaJob, value: number): void {
    if (record.job.status !== "running" || record.cancelRequested || !Number.isFinite(value)) return;
    const normalized = Math.min(100, Math.max(0, value));
    if (normalized < record.job.progress) return;
    record.job.progress = normalized;
  }

  async function execute(record: InternalMediaJob, handler: MediaJobHandler, controller: AbortController): Promise<void> {
    try {
      const context: MediaJobContext = Object.freeze({
        jobId: record.job.jobId,
        processingPreset: record.job.processingPreset,
        createdAt: record.job.createdAt
      });
      const result = await handler(context, controller.signal, (value) => updateProgress(record, value));

      if (record.job.status !== "running") return;
      if (record.cancelRequested || controller.signal.aborted) {
        transitionToCancelled(record);
        return;
      }

      record.job.result = sanitizeJobResult(result);
      record.job.progress = 100;
      transition(record, "ready");
    } catch (error) {
      if (record.job.status !== "running") return;
      if (record.cancelRequested || controller.signal.aborted || isCancellationError(error)) {
        transitionToCancelled(record);
        return;
      }

      record.job.error = handlerFailure(error);
      transition(record, "failed");
    } finally {
      record.controller = undefined;
      record.handler = undefined;
      runningJobs = Math.max(0, runningJobs - 1);
      scheduleDrain();
    }
  }

  function start(record: InternalMediaJob): void {
    const handler = record.handler;
    if (!handler) {
      transition(record, "running");
      record.job.error = safeFailure(API_ERROR_CODES.INTERNAL_ERROR);
      transition(record, "failed");
      return;
    }

    transition(record, "running");
    runningJobs += 1;
    const controller = new AbortController();
    record.controller = controller;
    void execute(record, handler, controller).catch(() => undefined);
  }

  function drain(): void {
    while (runningJobs < maxConcurrentJobs && pendingJobIds.length > 0) {
      const jobId = pendingJobIds.shift();
      if (!jobId) continue;
      const record = jobs.get(jobId);
      if (!record || record.job.status !== "queued") continue;
      start(record);
    }
  }

  function scheduleDrain(): void {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      try {
        drain();
      } catch {
        // Records validate their own transitions; keep scheduler faults out of the event loop.
      }
    });
  }

  function cleanupExpiredJobs(nowMs = currentTime()): number {
    if (!Number.isFinite(nowMs)) throw new TypeError("Cleanup timestamp must be finite.");
    let removed = 0;

    for (const [jobId, record] of jobs) {
      if (
        TERMINAL_STATUSES.has(record.job.status) &&
        record.expiresAtMs !== undefined &&
        record.expiresAtMs <= nowMs
      ) {
        transition(record, "expired", nowMs);
        jobs.delete(jobId);
        removed += 1;
      }
    }

    return removed;
  }

  function enqueue(enqueueOptions: EnqueueMediaJobOptions): EnqueuedMediaJob {
    cleanupExpiredJobs();
    if (
      !enqueueOptions ||
      !processingPresetIsValid(enqueueOptions.processingPreset) ||
      typeof enqueueOptions.handler !== "function"
    ) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
    }
    if (pendingJobIds.length >= maxQueuedJobs) {
      throw new AppError(API_ERROR_CODES.QUEUE_FULL);
    }

    const timestamp = currentTime();
    const jobId = uniqueJobId();
    let resolveSettled: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const record: InternalMediaJob = {
      job: {
        jobId,
        status: "queued",
        processingPreset: enqueueOptions.processingPreset,
        createdAt: isoTimestamp(timestamp),
        progress: 0
      },
      handler: enqueueOptions.handler,
      cancelRequested: false,
      settled,
      resolveSettled
    };

    jobs.set(jobId, record);
    pendingJobIds.push(jobId);
    scheduleDrain();
    return Object.freeze({ jobId, snapshot: immutableSnapshot(record.job) });
  }

  function getJob(jobId: string): MediaJobSnapshot {
    return immutableSnapshot(requireJob(jobId).job);
  }

  async function cancelJob(jobId: string): Promise<MediaJobSnapshot> {
    const record = requireJob(jobId);

    if (record.job.status === "queued") {
      const pendingIndex = pendingJobIds.indexOf(jobId);
      if (pendingIndex >= 0) pendingJobIds.splice(pendingIndex, 1);
      record.cancelRequested = true;
      transitionToCancelled(record);
      scheduleDrain();
      return immutableSnapshot(record.job);
    }

    if (record.job.status === "running") {
      if (!record.cancelRequested) {
        record.cancelRequested = true;
        record.controller?.abort();
      }
      await record.settled;
      return immutableSnapshot(record.job);
    }

    return immutableSnapshot(record.job);
  }

  function listJobs(): readonly MediaJobSnapshot[] {
    return Object.freeze(Array.from(jobs.values(), (record) => immutableSnapshot(record.job)));
  }

  function getStats(): MediaJobQueueStats {
    return Object.freeze({
      maxConcurrentJobs,
      maxQueuedJobs,
      runningJobs,
      queuedJobs: pendingJobIds.length,
      totalJobs: jobs.size
    });
  }

  return Object.freeze({ enqueue, getJob, cancelJob, cleanupExpiredJobs, listJobs, getStats });
}

type MediaJobQueueGlobal = typeof globalThis & {
  __videoSaveMediaJobQueueV1?: MediaJobQueue;
  __videoSaveMediaJobQueueWarningV1?: boolean;
};

const queueGlobal = globalThis as MediaJobQueueGlobal;

function getSingletonQueue(): MediaJobQueue {
  if (!queueGlobal.__videoSaveMediaJobQueueV1) {
    queueGlobal.__videoSaveMediaJobQueueV1 = createMediaJobQueue({
      maxConcurrentJobs: env.maxConcurrentJobs,
      maxQueuedJobs: env.maxQueuedJobs,
      terminalTtlMs: env.tempFileTtlMinutes * 60 * 1000
    });
  }

  if (env.nodeEnv === "production" && !queueGlobal.__videoSaveMediaJobQueueWarningV1) {
    console.warn("[VideoSave] The in-memory media queue is ephemeral and supports only one application instance.");
    queueGlobal.__videoSaveMediaJobQueueWarningV1 = true;
  }

  return queueGlobal.__videoSaveMediaJobQueueV1;
}

export const mediaJobQueue = getSingletonQueue();
export const enqueueMediaJob = mediaJobQueue.enqueue;
export const enqueueJob = enqueueMediaJob;
export const getJob = mediaJobQueue.getJob;
export const cancelJob = mediaJobQueue.cancelJob;
export const cleanupExpiredJobs = mediaJobQueue.cleanupExpiredJobs;

/** @internal Intended for tests and single-process administration only. */
export const listJobs = mediaJobQueue.listJobs;
