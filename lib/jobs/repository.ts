import type {
  CreateMediaJobRecordInput,
  MediaJobMutation
} from "@/lib/jobs/job-record";
import type { MediaJobRecord } from "@/lib/jobs/types";

export type JobRepositoryCreateResult =
  | Readonly<{ outcome: "created"; record: MediaJobRecord }>
  | Readonly<{ outcome: "duplicate"; record: MediaJobRecord }>
  | Readonly<{ outcome: "invalid-state" }>;

export type JobRepositoryUpdateResult =
  | Readonly<{ outcome: "updated"; record: MediaJobRecord }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "version-conflict"; record: MediaJobRecord }>
  | Readonly<{ outcome: "invalid-state"; record: MediaJobRecord }>;

export type JobRepositoryCancellationResult =
  | Readonly<{ outcome: "updated"; record: MediaJobRecord }>
  | Readonly<{ outcome: "unchanged"; record: MediaJobRecord }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{ outcome: "version-conflict"; record: MediaJobRecord }>;

/**
 * Data-store-neutral authoritative job-state boundary.
 *
 * Implementations must store serializable MediaJobRecord values only. Runtime
 * handlers, AbortControllers, promises, streams and process handles belong to
 * the local execution queue, never to this interface.
 */
export interface JobRepository {
  create(input: CreateMediaJobRecordInput): Promise<JobRepositoryCreateResult>;
  get(jobId: string): Promise<MediaJobRecord | null>;
  list(): Promise<readonly MediaJobRecord[]>;
  update(
    jobId: string,
    expectedVersion: number,
    mutation: MediaJobMutation
  ): Promise<JobRepositoryUpdateResult>;
  requestCancellation(
    jobId: string,
    expectedVersion: number
  ): Promise<JobRepositoryCancellationResult>;
  cleanupExpired(nowMs?: number): Promise<number>;
}
