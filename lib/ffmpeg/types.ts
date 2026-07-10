export type MediaTool = "ffmpeg" | "ffprobe";

export type MediaProcessFailureReason =
  | "spawn"
  | "non-zero-exit"
  | "timeout"
  | "aborted"
  | "stdout-limit";

export type MediaProcessOutputOverflow = "terminate" | "truncate-tail";

export type MediaProcessOutputPolicy = {
  maxBytes: number;
  overflow: MediaProcessOutputOverflow;
  onLine?: (line: string) => void;
};

export type MediaProcessRunOptions = {
  tool: MediaTool;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdout?: MediaProcessOutputPolicy;
  stderr?: MediaProcessOutputPolicy;
};

export type MediaProcessResult = {
  exitCode: 0;
  signal: null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
};

export type MediaRational = {
  numerator: number;
  denominator: number;
  value: number;
};

export type MediaVideoStream = {
  index: number;
  codec?: string;
  width?: number;
  height?: number;
  frameRate?: MediaRational;
  bitrate?: number;
  pixelFormat?: string;
  sampleAspectRatio?: MediaRational;
  rotationDegrees?: number;
  colorRange?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  durationSeconds?: number;
};

export type MediaAudioStream = {
  index: number;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  durationSeconds?: number;
};

export type MediaProbeResult = {
  durationSeconds: number;
  containerFormats: readonly string[];
  bitrate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoStreams: readonly MediaVideoStream[];
  audioStreams: readonly MediaAudioStream[];
};
