export const API_ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  RIGHTS_NOT_CONFIRMED: "RIGHTS_NOT_CONFIRMED",
  UNSUPPORTED_PRESET: "UNSUPPORTED_PRESET",
  INVALID_FORMAT: "INVALID_FORMAT",
  INVALID_URL: "INVALID_URL",
  UNSUPPORTED_PLATFORM: "UNSUPPORTED_PLATFORM",
  UNSUPPORTED_URL: "UNSUPPORTED_URL",
  PRIVATE_OR_LOCAL_URL: "PRIVATE_OR_LOCAL_URL",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  PROTECTED_CONTENT: "PROTECTED_CONTENT",
  RATE_LIMITED: "RATE_LIMITED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  VIDEO_TOO_LONG: "VIDEO_TOO_LONG",
  VIDEO_RESOLUTION_TOO_HIGH: "VIDEO_RESOLUTION_TOO_HIGH",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
  CONTENT_UNAVAILABLE: "CONTENT_UNAVAILABLE",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  PRIVATE_CONTENT: "PRIVATE_CONTENT",
  MEMBERS_ONLY: "MEMBERS_ONLY",
  DRM_PROTECTED: "DRM_PROTECTED",
  GEO_RESTRICTED: "GEO_RESTRICTED",
  REGION_RESTRICTED: "REGION_RESTRICTED",
  AGE_RESTRICTED: "AGE_RESTRICTED",
  CAPTCHA_OR_BOT_CHALLENGE: "CAPTCHA_OR_BOT_CHALLENGE",
  PHOTO_POST_NOT_SUPPORTED: "PHOTO_POST_NOT_SUPPORTED",
  IMAGE_POST_NOT_SUPPORTED: "IMAGE_POST_NOT_SUPPORTED",
  CAROUSEL_NOT_SUPPORTED: "CAROUSEL_NOT_SUPPORTED",
  STORY_NOT_SUPPORTED: "STORY_NOT_SUPPORTED",
  LIVE_NOT_SUPPORTED: "LIVE_NOT_SUPPORTED",
  PLAYLIST_NOT_SUPPORTED: "PLAYLIST_NOT_SUPPORTED",
  EXTERNAL_MEDIA_NOT_SUPPORTED: "EXTERNAL_MEDIA_NOT_SUPPORTED",
  POST_HAS_NO_VIDEO: "POST_HAS_NO_VIDEO",
  GALLERY_NOT_SUPPORTED: "GALLERY_NOT_SUPPORTED",
  SOURCE_HAS_NO_AUDIO: "SOURCE_HAS_NO_AUDIO",
  NO_SUPPORTED_FORMAT: "NO_SUPPORTED_FORMAT",
  EXTRACTOR_TIMEOUT: "EXTRACTOR_TIMEOUT",
  EXTRACTOR_FAILED: "EXTRACTOR_FAILED",
  SOURCE_EXPIRED: "SOURCE_EXPIRED",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  MERGE_FAILED: "MERGE_FAILED",
  OUTPUT_INVALID: "OUTPUT_INVALID",
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
