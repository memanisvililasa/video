import "server-only";
import { randomUUID } from "node:crypto";
import { isProcessingPreset, type CreateDownloadJobRequest } from "@/lib/api/media-job-dto";
import { AppError } from "@/lib/errors";
import {
  sanitizeMediaJobWorkItem,
  type JobLeaseQueue,
  type MediaJobWorkItem
} from "@/lib/jobs/job-lease-queue";
import { mediaJobRecordToSnapshot } from "@/lib/jobs/job-record";
import type { JobRepository } from "@/lib/jobs/repository";
import type { EnqueuedMediaJob, MediaJobSnapshot } from "@/lib/jobs/types";
import { API_ERROR_CODES } from "@/lib/types";

const FORMAT_ID = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_JOB_ID_ATTEMPTS = 10;

export type PersistentDownloadJobService = Readonly<{
  enqueueDownloadJob(request: CreateDownloadJobRequest): Promise<EnqueuedMediaJob>;
  getDownloadJob(jobId: string): Promise<MediaJobSnapshot>;
  cancelDownloadJob(jobId: string): Promise<MediaJobSnapshot>;
}>;

function createJobId(): string {
  return `job_${randomUUID().replaceAll("-", "")}`;
}

function validateWorkItem(request: CreateDownloadJobRequest): MediaJobWorkItem {
  if (!request || typeof request !== "object") {
    throw new AppError(API_ERROR_CODES.INVALID_REQUEST);
  }
  if (request.rightsConfirmed !== true) {
    throw new AppError(API_ERROR_CODES.RIGHTS_NOT_CONFIRMED);
  }
  if (!isProcessingPreset(request.processingPreset)) {
    throw new AppError(API_ERROR_CODES.UNSUPPORTED_PRESET);
  }
  if (typeof request.formatId !== "string" || !FORMAT_ID.test(request.formatId)) {
    throw new AppError(API_ERROR_CODES.INVALID_FORMAT);
  }
  try {
    return sanitizeMediaJobWorkItem({
      sourceUrl: request.url,
      formatId: request.formatId,
      processingPreset: request.processingPreset
    });
  } catch {
    throw new AppError(API_ERROR_CODES.INVALID_URL);
  }
}

export function createPersistentDownloadJobService(options: Readonly<{
  repository: JobRepository;
  queue: JobLeaseQueue;
  createJobId?: () => string;
}>): PersistentDownloadJobService {
  if (!options?.repository || !options.queue) {
    throw new TypeError("Persistent web job service requires PostgreSQL job ports.");
  }
  const nextJobId = options.createJobId ?? createJobId;

  async function enqueueDownloadJob(
    request: CreateDownloadJobRequest
  ): Promise<EnqueuedMediaJob> {
    const payload = validateWorkItem(request);
    for (let attempt = 0; attempt < MAX_JOB_ID_ATTEMPTS; attempt += 1) {
      const jobId = nextJobId();
      const result = await options.queue.enqueue({ jobId, ...payload });
      if (result.outcome === "created") {
        return Object.freeze({
          jobId: result.record.jobId,
          snapshot: mediaJobRecordToSnapshot(result.record)
        });
      }
      if (result.outcome === "invalid-state") {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
      }
    }
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR);
  }

  async function getDownloadJob(jobId: string): Promise<MediaJobSnapshot> {
    const record = await options.repository.get(jobId);
    if (!record) throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
    return mediaJobRecordToSnapshot(record);
  }

  async function cancelDownloadJob(jobId: string): Promise<MediaJobSnapshot> {
    const result = await options.queue.requestCancellation(jobId);
    if (result.outcome === "not-found") throw new AppError(API_ERROR_CODES.JOB_NOT_FOUND);
    return mediaJobRecordToSnapshot(result.record);
  }

  return Object.freeze({ enqueueDownloadJob, getDownloadJob, cancelDownloadJob });
}
