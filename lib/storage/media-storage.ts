import "server-only";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { isSafeDurableJobId, isSafeJobAttemptId } from "@/lib/jobs/job-lease-queue";

const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;
const SAFE_STORAGE_KEY = /^(?:jobs\/[a-zA-Z0-9_-]{1,128}\/attempts\/attempt_[a-f0-9]{32}\/(?:source|partial|staged)\/[a-zA-Z0-9._-]{1,128}|published\/[a-f0-9]{2}\/[a-f0-9]{2}\/file_[a-f0-9]{32}\.[a-z0-9]{1,8})$/;
const ARTIFACT_IDS = Object.freeze({
  source: /^source_[a-f0-9]{32}$/,
  partial: /^partial_[a-f0-9]{32}$/,
  final: /^file_[a-f0-9]{32}$/
});

export type MediaArtifactKind = "source" | "partial" | "final";
export type MediaPublicationState = "staged" | "published" | "missing";
export type MediaStorageKey = string & { readonly __mediaStorageKey: unique symbol };

export type MediaWriteTarget = Readonly<{
  key: MediaStorageKey;
  /** Server-only Phase A path for downloader/processor input; never serialize it. */
  localPath: string;
}>;

export type MediaAttemptWorkspace = Readonly<{
  jobId: string;
  attemptId: string;
  source: MediaWriteTarget;
  partial: MediaWriteTarget;
  stagedFinal: MediaWriteTarget;
}>;

export type MediaObjectDescriptor = Readonly<{
  key: MediaStorageKey;
  sizeBytes: number;
  checksumSha256: string;
  modifiedAt: string;
}>;

export type PublishedMediaObject = MediaObjectDescriptor & Readonly<{
  fileId: string;
}>;

export type OpenedMediaObject = Readonly<{
  sizeBytes: number;
  stream: Readable;
  close: () => Promise<void>;
}>;

export type MediaInventoryObject = Readonly<{
  key: MediaStorageKey;
  sizeBytes: number;
  modifiedAt: string;
}>;

export type MediaAttemptInventoryEntry = Readonly<{
  jobId: string;
  attemptId: string;
  modifiedAt: string;
}>;

export interface MediaObjectStorage {
  initialize(): Promise<void>;
  createAttemptWorkspace(input: Readonly<{
    jobId: string;
    attemptId: string;
    sourceExtension: string;
    outputExtension: string;
  }>): Promise<MediaAttemptWorkspace>;
  inspect(key: MediaStorageKey, maximumBytes: number): Promise<MediaObjectDescriptor>;
  stageOriginal(input: Readonly<{
    sourceKey: MediaStorageKey;
    stagedKey: MediaStorageKey;
    maximumBytes: number;
  }>): Promise<MediaObjectDescriptor>;
  publishImmutable(input: Readonly<{
    stagedKey: MediaStorageKey;
    fileId: string;
    extension: string;
    maximumBytes: number;
  }>): Promise<PublishedMediaObject>;
  open(key: MediaStorageKey, expectedSizeBytes: number): Promise<OpenedMediaObject>;
  stat(key: MediaStorageKey): Promise<MediaInventoryObject | null>;
  remove(key: MediaStorageKey): Promise<boolean>;
  removeAttemptWorkspace(jobId: string, attemptId: string): Promise<boolean>;
}

export interface MediaStorageInventory {
  listPublished(limit: number): Promise<readonly MediaInventoryObject[]>;
  listAttempts(limit: number): Promise<readonly MediaAttemptInventoryEntry[]>;
}

export interface MediaStorageHealth {
  /** Fail closed without exposing the configured root. */
  check(): Promise<void>;
}

export function createMediaArtifactId(kind: MediaArtifactKind): string {
  const prefix = kind === "final" ? "file" : kind;
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function isMediaArtifactId(value: unknown, kind?: MediaArtifactKind): value is string {
  if (typeof value !== "string") return false;
  return kind ? ARTIFACT_IDS[kind].test(value) : Object.values(ARTIFACT_IDS).some((pattern) => pattern.test(value));
}

export function isPublicMediaFileId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_IDS.final.test(value);
}

export function parseMediaStorageKey(value: unknown): MediaStorageKey {
  if (typeof value !== "string" || value.length > 512 || !SAFE_STORAGE_KEY.test(value)) {
    throw new TypeError("Media storage key is invalid.");
  }
  return value as MediaStorageKey;
}

export function validateMediaWorkspaceInput(input: Readonly<{
  jobId: string;
  attemptId: string;
  sourceExtension: string;
  outputExtension: string;
}>): Readonly<typeof input> {
  if (
    !isSafeDurableJobId(input.jobId) ||
    !isSafeJobAttemptId(input.attemptId) ||
    !SAFE_EXTENSION.test(input.sourceExtension) ||
    !SAFE_EXTENSION.test(input.outputExtension)
  ) {
    throw new TypeError("Media workspace identity is invalid.");
  }
  return Object.freeze({ ...input });
}

export function validateMediaExtension(value: unknown): string {
  if (typeof value !== "string" || !SAFE_EXTENSION.test(value)) {
    throw new TypeError("Media file extension is invalid.");
  }
  return value;
}
