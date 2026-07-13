import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import { prepareLocalMp4Output, type LocalMediaOutput, type LocalMediaOutputDirectoryPolicy } from "@/lib/ffmpeg/local-output";
import {
  MEDIA_PROCESS_OUTPUT_LIMITS,
  MediaProcessError,
  runMediaProcess
} from "@/lib/ffmpeg/process-runner";
import {
  assertMediaProbeLimits,
  DEFAULT_MEDIA_PROBE_LIMITS,
  probeMediaFile,
  resolveLocalMediaFile,
  type ProbeMediaFileOptions
} from "@/lib/ffmpeg/probe";
import type {
  CompatibleMp4Options,
  CompatibleMp4Result,
  MediaProbeResult,
  MediaProcessRunner,
  MediaVideoStream
} from "@/lib/ffmpeg/types";
import { normalizeStorageRoot } from "@/lib/storage/path-safety";
import { API_ERROR_CODES } from "@/lib/types";

export type { CompatibleMp4Options, CompatibleMp4Result } from "@/lib/ffmpeg/types";

const ALLOWED_DEMUXERS = "mov,matroska,webm";
const VIDEO_ENCODER = "libx264";
const AUDIO_ENCODER = "aac";
const VIDEO_PIXEL_FORMAT = "yuv420p";
const VIDEO_CRF = 23;
const VIDEO_PRESET = "medium";
const AUDIO_BIT_RATE = "160k";
const MAX_FFMPEG_THREADS = 6;
const LANDSCAPE_MAX_WIDTH = 1920;
const LANDSCAPE_MAX_HEIGHT = 1080;
const PORTRAIT_MAX_WIDTH = 1080;
const PORTRAIT_MAX_HEIGHT = 1920;
const MAX_ASPECT_RATIO_ERROR = 0.01;

type ProbeMedia = (inputPath: string, options?: ProbeMediaFileOptions) => Promise<MediaProbeResult>;

export type CompatibleMp4Dependencies = {
  runProcess: MediaProcessRunner;
  probeMedia: ProbeMedia;
  getAllowedRoot: () => string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxDurationSeconds: number;
  threads: number;
  outputDirectoryPolicy?: LocalMediaOutputDirectoryPolicy;
};

type CompatibleVideoPlan = {
  targetWidth: number;
  targetHeight: number;
  sourceDisplayWidth: number;
  sourceDisplayHeight: number;
  rotationDegrees: 0 | 90 | 180 | 270;
};

function processingFailedError(): AppError {
  return new AppError(API_ERROR_CODES.PROCESSING_FAILED);
}

function invalidVideoInputError(): AppError {
  return new AppError(
    API_ERROR_CODES.INVALID_MEDIA_FILE,
    "Для совместимого MP4 требуется корректный видеопоток."
  );
}

function unsupportedCodecError(): AppError {
  return new AppError(API_ERROR_CODES.UNSUPPORTED_CODEC);
}

function playableVideoStreams(metadata: MediaProbeResult): readonly MediaVideoStream[] {
  return metadata.videoStreams.filter((stream) => stream.attachedPicture !== true);
}

function normalizeRotation(value: number | undefined): 0 | 90 | 180 | 270 | undefined {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value)) return undefined;
  const normalized = ((value % 360) + 360) % 360;
  return normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270
    ? normalized
    : undefined;
}

function floorToEven(value: number): number {
  return Math.floor(value / 2) * 2;
}

function createVideoPlan(stream: MediaVideoStream): CompatibleVideoPlan {
  const width = stream.width;
  const height = stream.height;
  if (!width || !height || width < 2 || height < 2) throw invalidVideoInputError();

  const rotationDegrees = normalizeRotation(stream.rotationDegrees);
  if (rotationDegrees === undefined) throw invalidVideoInputError();

  const sampleAspectRatio = stream.sampleAspectRatio?.value ?? 1;
  if (!Number.isFinite(sampleAspectRatio) || sampleAspectRatio <= 0) throw invalidVideoInputError();

  const unrotatedDisplayWidth = width * sampleAspectRatio;
  const unrotatedDisplayHeight = height;
  const swapsAxes = rotationDegrees === 90 || rotationDegrees === 270;
  const sourceDisplayWidth = swapsAxes ? unrotatedDisplayHeight : unrotatedDisplayWidth;
  const sourceDisplayHeight = swapsAxes ? unrotatedDisplayWidth : unrotatedDisplayHeight;
  if (
    !Number.isFinite(sourceDisplayWidth) ||
    !Number.isFinite(sourceDisplayHeight) ||
    sourceDisplayWidth < 2 ||
    sourceDisplayHeight < 2
  ) {
    throw invalidVideoInputError();
  }

  const landscape = sourceDisplayWidth >= sourceDisplayHeight;
  const maxWidth = landscape ? LANDSCAPE_MAX_WIDTH : PORTRAIT_MAX_WIDTH;
  const maxHeight = landscape ? LANDSCAPE_MAX_HEIGHT : PORTRAIT_MAX_HEIGHT;
  const scale = Math.min(1, maxWidth / sourceDisplayWidth, maxHeight / sourceDisplayHeight);
  const targetWidth = floorToEven(sourceDisplayWidth * scale);
  const targetHeight = floorToEven(sourceDisplayHeight * scale);
  if (targetWidth < 2 || targetHeight < 2) throw invalidVideoInputError();

  const sourceAspectRatio = sourceDisplayWidth / sourceDisplayHeight;
  const targetAspectRatio = targetWidth / targetHeight;
  if (Math.abs(targetAspectRatio / sourceAspectRatio - 1) > MAX_ASPECT_RATIO_ERROR) {
    throw invalidVideoInputError();
  }

  return {
    targetWidth,
    targetHeight,
    sourceDisplayWidth,
    sourceDisplayHeight,
    rotationDegrees
  };
}

function assertDecodableInput(metadata: MediaProbeResult): MediaVideoStream {
  const primaryVideo = playableVideoStreams(metadata)[0];
  if (!primaryVideo) throw invalidVideoInputError();
  if (primaryVideo.codec === "unknown" || metadata.audioStreams[0]?.codec === "unknown") {
    throw unsupportedCodecError();
  }
  return primaryVideo;
}

function buildCompatibleMp4Arguments(
  inputPath: string,
  partialOutputPath: string,
  plan: CompatibleVideoPlan,
  threads: number
): readonly string[] {
  const videoFilter = `scale=${plan.targetWidth}:${plan.targetHeight}:flags=lanczos,setsar=1`;
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-n",
    "-filter_threads", String(threads),
    "-protocol_whitelist", "file",
    "-format_whitelist", ALLOWED_DEMUXERS,
    "-autorotate",
    "-i", inputPath,
    "-map", "0:V:0",
    "-map", "0:a:0?",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-c:v", VIDEO_ENCODER,
    "-preset:v", VIDEO_PRESET,
    "-crf:v", String(VIDEO_CRF),
    "-pix_fmt:v", VIDEO_PIXEL_FORMAT,
    "-vf", videoFilter,
    "-threads:v", String(threads),
    "-c:a", AUDIO_ENCODER,
    "-b:a", AUDIO_BIT_RATE,
    "-sn",
    "-dn",
    "-movflags", "+faststart",
    "-f", "mp4",
    "-nostats",
    partialOutputPath
  ];
}

function approximatelyEqual(left: number, right: number, tolerance: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function validateCompatibleMetadata(
  input: MediaProbeResult,
  output: MediaProbeResult,
  plan: CompatibleVideoPlan,
  maxDurationSeconds: number
): void {
  assertMediaProbeLimits(output, {
    maxDurationSeconds,
    maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
    maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
  });

  if (!output.containerFormats.includes("mp4")) throw processingFailedError();

  const outputVideos = playableVideoStreams(output);
  const expectedAudioStreams = input.audioStreams.length > 0 ? 1 : 0;
  if (outputVideos.length !== 1 || output.audioStreams.length !== expectedAudioStreams) {
    throw processingFailedError();
  }

  const video = outputVideos[0];
  if (
    video.codec !== "h264" ||
    video.width !== plan.targetWidth ||
    video.height !== plan.targetHeight ||
    (video.pixelFormat !== undefined && video.pixelFormat !== VIDEO_PIXEL_FORMAT) ||
    (video.sampleAspectRatio !== undefined && !approximatelyEqual(video.sampleAspectRatio.value, 1, 0.001)) ||
    normalizeRotation(video.rotationDegrees) !== 0
  ) {
    throw processingFailedError();
  }

  if (output.audioStreams[0]?.codec !== (expectedAudioStreams === 1 ? "aac" : undefined)) {
    throw processingFailedError();
  }

  if (
    video.width > plan.sourceDisplayWidth + 0.001 ||
    video.height > plan.sourceDisplayHeight + 0.001 ||
    video.width > (plan.targetWidth >= plan.targetHeight ? LANDSCAPE_MAX_WIDTH : PORTRAIT_MAX_WIDTH) ||
    video.height > (plan.targetWidth >= plan.targetHeight ? LANDSCAPE_MAX_HEIGHT : PORTRAIT_MAX_HEIGHT)
  ) {
    throw processingFailedError();
  }

  const inputVideo = playableVideoStreams(input)[0];
  if (inputVideo?.frameRate) {
    if (!video.frameRate) throw processingFailedError();
    const frameRateTolerance = Math.max(0.05, inputVideo.frameRate.value * 0.01);
    if (!approximatelyEqual(inputVideo.frameRate.value, video.frameRate.value, frameRateTolerance)) {
      throw processingFailedError();
    }
  }

  const durationTolerance = Math.max(1, input.durationSeconds * 0.01);
  if (!approximatelyEqual(input.durationSeconds, output.durationSeconds, durationTolerance)) {
    throw processingFailedError();
  }
}

function mapMediaProcessError(error: MediaProcessError): AppError {
  switch (error.reason) {
    case "spawn":
      return new AppError(API_ERROR_CODES.FFMPEG_NOT_AVAILABLE);
    case "timeout":
      return new AppError(API_ERROR_CODES.PROCESSING_TIMEOUT);
    case "aborted":
      return new AppError(API_ERROR_CODES.JOB_CANCELLED);
    case "stdout-limit":
    case "non-zero-exit":
      return processingFailedError();
  }
}

function mapOutputProbeError(error: unknown): AppError {
  if (error instanceof AppError) {
    if (
      error.code === API_ERROR_CODES.PROCESSING_TIMEOUT ||
      error.code === API_ERROR_CODES.JOB_CANCELLED ||
      error.code === API_ERROR_CODES.FFMPEG_NOT_AVAILABLE ||
      error.code === API_ERROR_CODES.OUTPUT_TOO_LARGE
    ) {
      return error;
    }
  }
  return processingFailedError();
}

/** @internal Exported to inject fake process/probe implementations in unit tests. */
export function createCompatibleMp4Converter(dependencies: CompatibleMp4Dependencies) {
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new TypeError("Compatible MP4 timeoutMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(dependencies.maxOutputBytes) || dependencies.maxOutputBytes <= 0) {
    throw new TypeError("Compatible MP4 maxOutputBytes must be a positive integer.");
  }
  if (!Number.isFinite(dependencies.maxDurationSeconds) || dependencies.maxDurationSeconds < 0) {
    throw new TypeError("Compatible MP4 maxDurationSeconds must be a non-negative number.");
  }
  if (!Number.isSafeInteger(dependencies.threads) || dependencies.threads <= 0) {
    throw new TypeError("Compatible MP4 threads must be a positive integer.");
  }

  const threads = Math.min(dependencies.threads, MAX_FFMPEG_THREADS);

  return async function convertMediaToCompatibleMp4(
    options: CompatibleMp4Options
  ): Promise<CompatibleMp4Result> {
    let output: LocalMediaOutput | undefined;

    try {
      const inputFile = await resolveLocalMediaFile(options.inputPath, dependencies.getAllowedRoot);
      output = await prepareLocalMp4Output(
        options.outputPath,
        inputFile.realPath,
        dependencies.getAllowedRoot,
        dependencies.outputDirectoryPolicy
      );

      const inputMetadata = await dependencies.probeMedia(inputFile.realPath, { signal: options.signal });
      assertMediaProbeLimits(inputMetadata, {
        maxDurationSeconds: dependencies.maxDurationSeconds,
        maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
        maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
      });
      const primaryVideo = assertDecodableInput(inputMetadata);
      const plan = createVideoPlan(primaryVideo);

      output.markProcessStarted();
      const processResult = await dependencies.runProcess({
        tool: "ffmpeg",
        args: buildCompatibleMp4Arguments(inputFile.realPath, output.partialPath, plan, threads),
        cwd: output.jobDirectory,
        timeoutMs: dependencies.timeoutMs,
        signal: options.signal,
        stdout: {
          maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.ffmpegStdoutBytes,
          overflow: "truncate-tail"
        },
        stderr: {
          maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.stderrBytes,
          overflow: "truncate-tail"
        }
      });
      if (processResult.stdoutTruncated) throw processingFailedError();

      await output.assertPartialFile(dependencies.maxOutputBytes);

      let outputMetadata: MediaProbeResult;
      try {
        outputMetadata = await dependencies.probeMedia(output.partialPath, { signal: options.signal });
      } catch (error) {
        throw mapOutputProbeError(error);
      }
      validateCompatibleMetadata(inputMetadata, outputMetadata, plan, dependencies.maxDurationSeconds);

      await output.publish();
      const sizeBytes = await output.assertFinalFile(dependencies.maxOutputBytes);

      return {
        preset: "compatible-mp4",
        input: inputMetadata,
        output: outputMetadata,
        outputPath: output.finalPath,
        sizeBytes,
        targetWidth: plan.targetWidth,
        targetHeight: plan.targetHeight,
        videoEncoder: VIDEO_ENCODER,
        audioEncoder: inputMetadata.audioStreams.length > 0 ? AUDIO_ENCODER : null,
        threads
      };
    } catch (error) {
      if (output) await output.cleanup();
      if (error instanceof MediaProcessError) throw mapMediaProcessError(error);
      if (error instanceof AppError) throw error;
      throw processingFailedError();
    }
  };
}

export const convertMediaToCompatibleMp4 = createCompatibleMp4Converter({
  runProcess: runMediaProcess,
  probeMedia: probeMediaFile,
  getAllowedRoot: () => normalizeStorageRoot(env.storagePath),
  timeoutMs: env.ffmpegTimeoutSeconds * 1000,
  maxOutputBytes: Math.max(1, Math.floor(env.maxFileSizeMb * 1024 * 1024)),
  maxDurationSeconds: env.maxVideoDurationMinutes * 60,
  threads: env.ffmpegThreads
});

export function convertToMp4(
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal
): Promise<CompatibleMp4Result> {
  return convertMediaToCompatibleMp4({ inputPath, outputPath, signal });
}
