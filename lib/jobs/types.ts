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

export type MediaJob = {
  jobId: string;
  status: MediaJobStatus;
  processingPreset: ProcessingPreset;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  progress: number;
  result?: MediaJobResult;
  error?: MediaJobFailure;
};

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
