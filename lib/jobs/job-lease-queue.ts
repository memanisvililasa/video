import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";
import type { MediaJobSourceMetadataInput } from "@/lib/jobs/job-record";
import type { MediaJobRecord, MediaJobResult } from "@/lib/jobs/types";
import { validateVideoUrl } from "@/lib/security/url-validation";
import type { ApiErrorCode } from "@/lib/types";

const SAFE_JOB_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_FORMAT_ID = /^[a-zA-Z0-9._-]{1,64}$/;
const SAFE_WORKER_ID = /^worker_[a-f0-9]{32}$/;
const SAFE_ATTEMPT_ID = /^attempt_[a-f0-9]{32}$/;
const VALID_PROCESSING_PRESETS = new Set<ProcessingPreset>([
  "original",
  "remux-to-mp4",
  "compatible-mp4",
  "audio-only"
]);
const SENSITIVE_QUERY_PARAMETER =
  /(?:access[-_]?token|auth(?:orization)?|credential|password|secret|signature|(?:^|[-_])sig(?:$|[-_])|(?:^|[-_])token(?:$|[-_])|api[-_]?key)/i;

export const DURABLE_JOB_PAYLOAD_LIMITS = Object.freeze({
  sourceUrlCharacters: 2_048,
  serializedBytes: 4_096
});

export type MediaJobWorkItem = Readonly<{
  sourceUrl: string;
  formatId: string;
  processingPreset: ProcessingPreset;
}>;

export type EnqueueDurableMediaJobInput = Readonly<{
  jobId: string;
  sourceUrl: string;
  formatId: string;
  processingPreset: ProcessingPreset;
}>;

export type JobLeaseRef = Readonly<{
  jobId: string;
  workerId: string;
  attemptId: string;
  version: number;
  leaseExpiresAt: string;
}>;

export type ClaimedMediaJob = Readonly<{
  record: MediaJobRecord;
  workItem: MediaJobWorkItem;
  lease: JobLeaseRef;
}>;

export type JobLeaseQueueEnqueueResult =
  | Readonly<{ outcome: "created"; record: MediaJobRecord }>
  | Readonly<{ outcome: "duplicate"; record: MediaJobRecord }>
  | Readonly<{ outcome: "invalid-state" }>;

export type JobLeaseQueueClaimResult =
  | Readonly<{ outcome: "claimed"; job: ClaimedMediaJob }>
  | Readonly<{ outcome: "empty" }>;

export type OwnedJobUpdateResult =
  | Readonly<{ outcome: "updated"; record: MediaJobRecord; lease: JobLeaseRef }>
  | Readonly<{ outcome: "cancelled"; record: MediaJobRecord }>
  | Readonly<{ outcome: "invalid-state"; record: MediaJobRecord }>
  | Readonly<{ outcome: "ownership-lost" }>
  | Readonly<{ outcome: "not-found" }>;

export type OwnedJobObservationResult =
  | Readonly<{ outcome: "active"; record: MediaJobRecord }>
  | Readonly<{ outcome: "cancelled"; record: MediaJobRecord }>
  | Readonly<{ outcome: "expired"; record: MediaJobRecord }>
  | Readonly<{ outcome: "terminal"; record: MediaJobRecord }>
  | Readonly<{ outcome: "ownership-lost" }>
  | Readonly<{ outcome: "not-found" }>;

export type OwnedJobCompletion =
  | Readonly<{ type: "ready"; result: MediaJobResult }>
  | Readonly<{ type: "failed"; errorCode: ApiErrorCode }>
  | Readonly<{ type: "cancelled" }>;

export type OwnedJobCompletionResult =
  | Readonly<{ outcome: "completed"; record: MediaJobRecord }>
  | Readonly<{ outcome: "already-completed"; record: MediaJobRecord }>
  | Readonly<{ outcome: "invalid-state"; record: MediaJobRecord }>
  | Readonly<{ outcome: "ownership-lost" }>
  | Readonly<{ outcome: "not-found" }>;

export type JobLeaseQueueCancellationResult =
  | Readonly<{ outcome: "cancelled"; record: MediaJobRecord }>
  | Readonly<{ outcome: "unchanged"; record: MediaJobRecord }>
  | Readonly<{ outcome: "not-found" }>;

export type JobLeaseRecoveryResult = Readonly<{
  requeued: readonly MediaJobRecord[];
  failed: readonly MediaJobRecord[];
}>;

export interface JobLeaseQueue {
  enqueue(input: EnqueueDurableMediaJobInput): Promise<JobLeaseQueueEnqueueResult>;
  claimNext(workerId: string): Promise<JobLeaseQueueClaimResult>;
  requestCancellation(jobId: string): Promise<JobLeaseQueueCancellationResult>;
  observeOwnedState(lease: JobLeaseRef): Promise<OwnedJobObservationResult>;
  renewLease(lease: JobLeaseRef): Promise<OwnedJobUpdateResult>;
  setSourceMetadataOwned(
    lease: JobLeaseRef,
    sourceMetadata: MediaJobSourceMetadataInput
  ): Promise<OwnedJobUpdateResult>;
  updateProgressOwned(lease: JobLeaseRef, progress: number): Promise<OwnedJobUpdateResult>;
  completeOwned(
    lease: JobLeaseRef,
    completion: OwnedJobCompletion
  ): Promise<OwnedJobCompletionResult>;
  recoverExpiredLeases(): Promise<JobLeaseRecoveryResult>;
}

export function createJobWorkerId(prefix = "worker"): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(prefix)) {
    throw new TypeError("Job worker ID prefix is invalid.");
  }
  const suffix = createHash("sha256")
    .update(prefix)
    .update(":" + randomUUID())
    .digest("hex")
    .slice(0, 32);
  return `worker_${suffix}`;
}

export function createJobAttemptId(): string {
  return `attempt_${randomUUID().replaceAll("-", "")}`;
}

export function isSafeJobWorkerId(value: unknown): value is string {
  return typeof value === "string" && SAFE_WORKER_ID.test(value);
}

export function isSafeJobAttemptId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ATTEMPT_ID.test(value);
}

export function isSafeDurableJobId(value: unknown): value is string {
  return typeof value === "string" && SAFE_JOB_ID.test(value);
}

export function sanitizeMediaJobWorkItem(value: unknown): MediaJobWorkItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Durable media job payload is invalid.");
  }
  const input = value as Partial<MediaJobWorkItem>;
  if (
    typeof input.sourceUrl !== "string" ||
    typeof input.formatId !== "string" ||
    !SAFE_FORMAT_ID.test(input.formatId) ||
    typeof input.processingPreset !== "string" ||
    !VALID_PROCESSING_PRESETS.has(input.processingPreset as ProcessingPreset)
  ) {
    throw new TypeError("Durable media job payload is invalid.");
  }

  const validation = validateVideoUrl(input.sourceUrl, {
    maxLength: DURABLE_JOB_PAYLOAD_LIMITS.sourceUrlCharacters
  });
  if (!validation.ok) throw new TypeError("Durable media job payload is invalid.");
  for (const key of validation.url.searchParams.keys()) {
    if (SENSITIVE_QUERY_PARAMETER.test(key)) {
      throw new TypeError("Durable media job payload must not contain credentials or tokens.");
    }
  }

  const workItem = Object.freeze({
    sourceUrl: validation.normalizedUrl,
    formatId: input.formatId,
    processingPreset: input.processingPreset as ProcessingPreset
  });
  if (
    new TextEncoder().encode(JSON.stringify(workItem)).byteLength >
    DURABLE_JOB_PAYLOAD_LIMITS.serializedBytes
  ) {
    throw new TypeError("Durable media job payload exceeds its supported size.");
  }
  return workItem;
}
