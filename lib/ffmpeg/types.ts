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

export type MediaProcessRunner = (options: MediaProcessRunOptions) => Promise<MediaProcessResult>;

export type MediaRational = {
  numerator: number;
  denominator: number;
  value: number;
};

export type MediaStreamInfo = {
  index: number;
  codec: string;
  bitRate?: number;
  durationSeconds?: number;
};

export type MediaVideoStream = MediaStreamInfo & {
  width?: number;
  height?: number;
  attachedPicture?: boolean;
  frameRate?: MediaRational;
  pixelFormat?: string;
  sampleAspectRatio?: MediaRational;
  rotationDegrees?: number;
  colorRange?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
};

export type MediaAudioStream = MediaStreamInfo & {
  sampleRate?: number;
  channels?: number;
};

export type MediaFormatInfo = {
  formatName: string;
  containerFormats: readonly string[];
  durationSeconds: number;
  sizeBytes: number;
  bitRate?: number;
};

export type MediaProbeResult = {
  durationSeconds: number;
  formatName: string;
  containerFormats: readonly string[];
  sizeBytes: number;
  bitRate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoStreams: readonly MediaVideoStream[];
  audioStreams: readonly MediaAudioStream[];
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  frameRate?: MediaRational;
  format: MediaFormatInfo;
};

export type MediaProbeLimits = {
  maxDurationSeconds: number;
  maxPixels: number;
  maxDimension: number;
};

export type ProcessingPreset = "original" | "remux-to-mp4" | "compatible-mp4" | "audio-only";

export type MediaProcessingResult<TPreset extends ProcessingPreset = ProcessingPreset> = {
  preset: TPreset;
  input: MediaProbeResult;
  output: MediaProbeResult;
  outputPath: string;
  sizeBytes: number;
};

export type RemuxMediaOptions = {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
};

export type RemuxMediaResult = MediaProcessingResult<"remux-to-mp4"> & {
  copiedVideoStreams: number;
  copiedAudioStreams: number;
};

export type CompatibleMp4Options = {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
};

export type CompatibleMp4Result = MediaProcessingResult<"compatible-mp4"> & {
  targetWidth: number;
  targetHeight: number;
  videoEncoder: "libx264";
  audioEncoder: "aac" | null;
  threads: number;
};

export type AudioExtractionOptions = {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
};

export type AudioExtractionResult = MediaProcessingResult<"audio-only"> & {
  audioEncoder: "aac";
  bitRate: 192_000;
  sourceAudioStreamIndex: number;
  channels?: number;
  threads: number;
};

export type MergeAudioVideoOptions = {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  container: "mp4" | "webm";
  signal?: AbortSignal;
};

export type MergeAudioVideoResult = {
  outputPath: string;
  sizeBytes: number;
  videoInput: MediaProbeResult;
  audioInput: MediaProbeResult;
  output: MediaProbeResult;
};
