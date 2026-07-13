import "server-only";
import type { JobLeaseRef } from "@/lib/jobs/job-lease-queue";
import type { MediaJobOutputMetadata, MediaJobRecord } from "@/lib/jobs/types";
import type {
  MediaArtifactKind,
  MediaObjectDescriptor,
  MediaPublicationState,
  MediaStorageKey,
  PublishedMediaObject
} from "@/lib/storage/media-storage";

export type MediaArtifactRecord = Readonly<{
  artifactId: string;
  jobId: string;
  attemptId: string;
  kind: MediaArtifactKind;
  publicationState: MediaPublicationState;
  storageKey: MediaStorageKey;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  expiresAt: string;
  version: number;
}>;

export type ReserveMediaArtifactInput = Readonly<{
  artifactId: string;
  kind: MediaArtifactKind;
  object: MediaObjectDescriptor;
  filename: string;
  contentType: string;
  ttlSeconds: number;
}>;

export type ReserveMediaArtifactResult =
  | Readonly<{ outcome: "reserved" | "already-reserved"; artifact: MediaArtifactRecord; lease: JobLeaseRef }>
  | Readonly<{ outcome: "ownership-lost" }>
  | Readonly<{ outcome: "invalid-state"; record: MediaJobRecord | null }>
  | Readonly<{ outcome: "not-found" }>;

export type PublishReadyInput = Readonly<{
  lease: JobLeaseRef;
  artifactId: string;
  publishedObject: PublishedMediaObject;
  media: MediaJobOutputMetadata;
}>;

export type PublishReadyResult =
  | Readonly<{ outcome: "completed" | "already-completed"; artifact: MediaArtifactRecord; record: MediaJobRecord }>
  | Readonly<{ outcome: "ownership-lost" }>
  | Readonly<{ outcome: "invalid-state"; record: MediaJobRecord | null }>
  | Readonly<{ outcome: "not-found" }>;

export type ArtifactMutationResult =
  | Readonly<{ outcome: "updated"; artifact: MediaArtifactRecord }>
  | Readonly<{ outcome: "unchanged"; artifact: MediaArtifactRecord }>
  | Readonly<{ outcome: "version-conflict"; artifact: MediaArtifactRecord }>
  | Readonly<{ outcome: "not-found" }>;

export interface MediaArtifactRepository {
  reserveOwned(lease: JobLeaseRef, input: ReserveMediaArtifactInput): Promise<ReserveMediaArtifactResult>;
  get(artifactId: string): Promise<MediaArtifactRecord | null>;
  getPublicFinal(fileId: string): Promise<MediaArtifactRecord | null>;
  listForJob(jobId: string): Promise<readonly MediaArtifactRecord[]>;
  listReconciliationCandidates(limit: number): Promise<readonly MediaArtifactRecord[]>;
  listExpiredPublished(limit: number): Promise<readonly MediaArtifactRecord[]>;
  findByStorageKeys(keys: readonly MediaStorageKey[]): Promise<readonly MediaArtifactRecord[]>;
  markMissing(artifactId: string, expectedVersion: number): Promise<ArtifactMutationResult>;
  delete(artifactId: string, expectedVersion: number): Promise<ArtifactMutationResult>;
  isAttemptActive(jobId: string, attemptId: string): Promise<boolean>;
  isOwnedLeaseActive(lease: JobLeaseRef): Promise<boolean>;
}

export interface FinalPublicationCoordinator {
  completeReadyOwned(input: PublishReadyInput): Promise<PublishReadyResult>;
}
