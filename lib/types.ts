export type ApiErrorCode =
  | "UNSUPPORTED_URL"
  | "PUBLIC_ACCESS_DENIED"
  | "METADATA_FAILED"
  | "DOWNLOAD_FAILED"
  | "FILE_TOO_LARGE"
  | "VIDEO_TOO_LONG"
  | "PROTECTED_CONTENT"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "VALIDATION_ERROR"
  | "NOT_IMPLEMENTED"
  | "INTERNAL_ERROR";

export type ApiError = {
  code: ApiErrorCode;
  message: string;
};

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

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

export type PreparedFile = {
  id: string;
  downloadUrl: string;
  filename: string;
  sizeBytes: number;
  expiresAt: string;
};

export type ExtractRequest = {
  url: string;
};

export type DownloadRequest = {
  url: string;
  formatId: string;
};
