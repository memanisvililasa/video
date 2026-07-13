import type { ProcessingPreset } from "@/lib/ffmpeg/types";
import type { ApiErrorCode } from "@/lib/types";

export type MediaJobStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | "expired";

export type MediaJobResult = {
  fileId: string;
  downloadUrl: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  expiresAt: string;
  processingPreset: ProcessingPreset;
  media: MediaJobOutputMetadata;
};

export type MediaJobOutputMetadata = Readonly<{
  durationSeconds: number;
  formatName: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
}>;

export type MediaJobFailure = {
  code: ApiErrorCode;
  message: string;
};

export type MediaJobSourceMetadata = Readonly<{
  sourceId: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  registeredAt: string;
}>;

/**
 * Serializable authoritative job state. Runtime-only handlers, promises,
 * AbortControllers, process handles and local paths must never be added here.
 */
export type MediaJobRecord = Readonly<{
  jobId: string;
  status: MediaJobStatus;
  processingPreset: ProcessingPreset;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  cancellationRequestedAt: string | null;
  progress: number;
  sourceMetadata: MediaJobSourceMetadata | null;
  finalMetadata: Readonly<MediaJobResult> | null;
  canonicalError: Readonly<MediaJobFailure> | null;
  retryCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  version: number;
}>;

/** @deprecated Use MediaJobRecord for persistence and MediaJobSnapshot for API-facing reads. */
export type MediaJob = MediaJobRecord;

export type MediaJobSnapshot = Readonly<{
  jobId: string;
  status: MediaJobStatus;
  processingPreset: ProcessingPreset;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  progress: number;
  result?: Readonly<MediaJobResult>;
  error?: Readonly<MediaJobFailure>;
}>;

export type MediaJobContext = Readonly<{
  jobId: string;
  processingPreset: ProcessingPreset;
  createdAt: string;
}>;

export type MediaJobProgressUpdater = (progress: number) => void;

export type MediaJobHandler = (
  context: MediaJobContext,
  signal: AbortSignal,
  updateProgress: MediaJobProgressUpdater
) => MediaJobResult | Promise<MediaJobResult>;

export type MediaJobDiscardHandler = () => void | Promise<void>;

export type EnqueueMediaJobOptions = {
  processingPreset: ProcessingPreset;
  handler: MediaJobHandler;
  onDiscard?: MediaJobDiscardHandler;
};

export type EnqueuedMediaJob = Readonly<{
  jobId: string;
  snapshot: MediaJobSnapshot;
}>;

export type MediaJobQueueStats = Readonly<{
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  runningJobs: number;
  queuedJobs: number;
  totalJobs: number;
}>;
