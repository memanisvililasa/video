export const API_ERROR_CODES = {
  INVALID_URL: "INVALID_URL",
  UNSUPPORTED_URL: "UNSUPPORTED_URL",
  PRIVATE_OR_LOCAL_URL: "PRIVATE_OR_LOCAL_URL",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  PROTECTED_CONTENT: "PROTECTED_CONTENT",
  RATE_LIMITED: "RATE_LIMITED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  VIDEO_TOO_LONG: "VIDEO_TOO_LONG",
  VIDEO_RESOLUTION_TOO_HIGH: "VIDEO_RESOLUTION_TOO_HIGH",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  FFMPEG_NOT_AVAILABLE: "FFMPEG_NOT_AVAILABLE",
  FFPROBE_FAILED: "FFPROBE_FAILED",
  INVALID_MEDIA_FILE: "INVALID_MEDIA_FILE",
  AUDIO_STREAM_NOT_FOUND: "AUDIO_STREAM_NOT_FOUND",
  UNSUPPORTED_CODEC: "UNSUPPORTED_CODEC",
  PROCESSING_FAILED: "PROCESSING_FAILED",
  PROCESSING_TIMEOUT: "PROCESSING_TIMEOUT",
  OUTPUT_TOO_LARGE: "OUTPUT_TOO_LARGE",
  JOB_CANCELLED: "JOB_CANCELLED",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  QUEUE_FULL: "QUEUE_FULL",
  INVALID_JOB_STATE: "INVALID_JOB_STATE",
  INTERNAL_ERROR: "INTERNAL_ERROR"
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type ApiFailure = {
  ok: false;
  error: ApiError;
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export type VideoFormat = {
  id: string;
  label: string;
  ext: string;
  quality?: string;
  width?: number;
  height?: number;
  filesizeBytes?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
};

export type VideoMetadata = {
  id: string;
  originalUrl: string;
  title: string;
  thumbnail?: string;
  durationSeconds?: number;
  platform: string;
  formats: VideoFormat[];
};

export type DownloadJobStatus = "queued" | "processing" | "ready" | "failed";

export type DownloadJob = {
  id: string;
  status: DownloadJobStatus;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  fileId?: string;
  message?: string;
};

export type DownloadFile = {
  id: string;
  downloadUrl: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  expiresAt: string;
};

export type PreparedFile = DownloadFile;

export type ExtractRequest = {
  url: string;
};

export type ExtractResponse = ApiResponse<VideoMetadata>;

export type DownloadRequest = {
  url: string;
  formatId: string;
};

export type DownloadResponse = ApiResponse<{
  job: DownloadJob;
  file?: DownloadFile;
}>;

export type HealthResponse = ApiResponse<{
  status: "ok";
}>;
