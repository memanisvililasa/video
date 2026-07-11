import type { ApiErrorCode } from "@/lib/types";

export const PROCESSING_PRESETS = Object.freeze([
  "original",
  "remux-to-mp4",
  "compatible-mp4",
  "audio-only"
] as const);

export type ProcessingPreset = (typeof PROCESSING_PRESETS)[number];
const PROCESSING_PRESET_SET: ReadonlySet<string> = new Set(PROCESSING_PRESETS);

export function isProcessingPreset(value: unknown): value is ProcessingPreset {
  return typeof value === "string" && PROCESSING_PRESET_SET.has(value);
}

export type CreateDownloadJobRequest = {
  url: string;
  formatId: string;
  processingPreset: ProcessingPreset;
  rightsConfirmed: true;
};

export type MediaJobApiStatus = "queued" | "running" | "ready" | "failed" | "cancelled" | "expired";

export type MediaJobApiMetadata = Readonly<{
  durationSeconds: number;
  formatName: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
}>;

export type MediaJobApiResult = Readonly<{
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  expiresAt: string;
  processingPreset: ProcessingPreset;
  media: MediaJobApiMetadata;
}>;

export type MediaJobApiError = Readonly<{
  code: ApiErrorCode;
  message: string;
}>;

type MediaJobApiSnapshotBase = Readonly<{
  jobId: string;
  status: MediaJobApiStatus;
  progress: number;
  processingPreset: ProcessingPreset;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
}>;

export type MediaJobApiSnapshot =
  | (MediaJobApiSnapshotBase & Readonly<{
      status: "queued" | "running" | "cancelled" | "expired";
      result?: never;
      error?: never;
    }>)
  | (MediaJobApiSnapshotBase & Readonly<{
      status: "ready";
      result: MediaJobApiResult;
      error?: never;
    }>)
  | (MediaJobApiSnapshotBase & Readonly<{
      status: "failed";
      result?: never;
      error: MediaJobApiError;
    }>);

export type CreateDownloadJobData = Readonly<{
  jobId: string;
  status: "queued";
  progress: number;
  processingPreset: ProcessingPreset;
  createdAt: string;
  expiresAt: null;
  statusUrl: string;
  cancelUrl: string;
}>;

export type ApiSuccess<T> = Readonly<{
  ok: true;
  data: T;
}>;

export type ApiFailure = Readonly<{
  ok: false;
  error: MediaJobApiError;
}>;

export type CreateDownloadJobResponse = ApiSuccess<CreateDownloadJobData> | ApiFailure;
