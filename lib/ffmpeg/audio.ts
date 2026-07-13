import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import { prepareLocalM4aOutput, type LocalMediaOutput, type LocalMediaOutputDirectoryPolicy } from "@/lib/ffmpeg/local-output";
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
  AudioExtractionOptions,
  AudioExtractionResult,
  MediaAudioStream,
  MediaProbeResult,
  MediaProcessRunner
} from "@/lib/ffmpeg/types";
import { normalizeStorageRoot } from "@/lib/storage/path-safety";
import { API_ERROR_CODES } from "@/lib/types";

export type { AudioExtractionOptions, AudioExtractionResult } from "@/lib/ffmpeg/types";

const ALLOWED_DEMUXERS = "mov,matroska,webm";
const AUDIO_ENCODER = "aac";
const AUDIO_BIT_RATE = "192k";
const AUDIO_BIT_RATE_BPS = 192_000;
const MAX_AUDIO_CHANNELS = 8;
const MAX_FFMPEG_THREADS = 6;

type ProbeMedia = (inputPath: string, options?: ProbeMediaFileOptions) => Promise<MediaProbeResult>;

export type AudioExtractionDependencies = {
  runProcess: MediaProcessRunner;
  probeMedia: ProbeMedia;
  getAllowedRoot: () => string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxDurationSeconds: number;
  threads: number;
  outputDirectoryPolicy?: LocalMediaOutputDirectoryPolicy;
};

function processingFailedError(): AppError {
  return new AppError(API_ERROR_CODES.PROCESSING_FAILED);
}

function audioStreamNotFoundError(): AppError {
  return new AppError(API_ERROR_CODES.AUDIO_STREAM_NOT_FOUND);
}

function unsupportedCodecError(): AppError {
  return new AppError(API_ERROR_CODES.UNSUPPORTED_CODEC);
}

function playableVideoStreamCount(metadata: MediaProbeResult): number {
  return metadata.videoStreams.filter((stream) => stream.attachedPicture !== true).length;
}

function selectInputAudioStream(metadata: MediaProbeResult): MediaAudioStream {
  const stream = metadata.audioStreams[0];
  if (!stream) throw audioStreamNotFoundError();
  if (stream.codec === "unknown" || (stream.channels !== undefined && stream.channels > MAX_AUDIO_CHANNELS)) {
    throw unsupportedCodecError();
  }
  return stream;
}

function buildAudioExtractionArguments(
  inputPath: string,
  partialOutputPath: string,
  threads: number
): readonly string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-n",
    "-protocol_whitelist", "file",
    "-format_whitelist", ALLOWED_DEMUXERS,
    "-i", inputPath,
    "-map", "0:a:0",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-vn",
    "-sn",
    "-dn",
    "-c:a", AUDIO_ENCODER,
    "-b:a", AUDIO_BIT_RATE,
    "-threads:a", String(threads),
    "-movflags", "+faststart",
    "-f", "ipod",
    "-nostats",
    partialOutputPath
  ];
}

function approximatelyEqual(left: number, right: number, tolerance: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function validateExtractedAudio(
  input: MediaProbeResult,
  inputAudio: MediaAudioStream,
  output: MediaProbeResult,
  maxDurationSeconds: number
): MediaAudioStream {
  assertMediaProbeLimits(output, {
    maxDurationSeconds,
    maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
    maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
  });

  if (!output.containerFormats.some((format) => format === "m4a" || format === "mp4")) {
    throw processingFailedError();
  }
  if (playableVideoStreamCount(output) !== 0 || output.audioStreams.length !== 1) {
    throw processingFailedError();
  }

  const outputAudio = output.audioStreams[0];
  if (
    outputAudio.codec !== AUDIO_ENCODER ||
    (outputAudio.channels !== undefined && outputAudio.channels > MAX_AUDIO_CHANNELS) ||
    (inputAudio.channels !== undefined && outputAudio.channels !== inputAudio.channels)
  ) {
    throw processingFailedError();
  }

  const expectedDuration = inputAudio.durationSeconds ?? input.durationSeconds;
  const durationTolerance = Math.max(1, expectedDuration * 0.01);
  if (!approximatelyEqual(expectedDuration, output.durationSeconds, durationTolerance)) {
    throw processingFailedError();
  }

  return outputAudio;
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
export function createAudioExtractor(dependencies: AudioExtractionDependencies) {
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new TypeError("Audio extraction timeoutMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(dependencies.maxOutputBytes) || dependencies.maxOutputBytes <= 0) {
    throw new TypeError("Audio extraction maxOutputBytes must be a positive integer.");
  }
  if (!Number.isFinite(dependencies.maxDurationSeconds) || dependencies.maxDurationSeconds < 0) {
    throw new TypeError("Audio extraction maxDurationSeconds must be a non-negative number.");
  }
  if (!Number.isSafeInteger(dependencies.threads) || dependencies.threads <= 0) {
    throw new TypeError("Audio extraction threads must be a positive integer.");
  }

  const threads = Math.min(dependencies.threads, MAX_FFMPEG_THREADS);

  return async function extractAudioToM4a(options: AudioExtractionOptions): Promise<AudioExtractionResult> {
    let output: LocalMediaOutput | undefined;

    try {
      const inputFile = await resolveLocalMediaFile(options.inputPath, dependencies.getAllowedRoot);
      output = await prepareLocalM4aOutput(
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
      const inputAudio = selectInputAudioStream(inputMetadata);

      output.markProcessStarted();
      const processResult = await dependencies.runProcess({
        tool: "ffmpeg",
        args: buildAudioExtractionArguments(inputFile.realPath, output.partialPath, threads),
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
      const outputAudio = validateExtractedAudio(
        inputMetadata,
        inputAudio,
        outputMetadata,
        dependencies.maxDurationSeconds
      );

      await output.publish();
      const sizeBytes = await output.assertFinalFile(dependencies.maxOutputBytes);

      return {
        preset: "audio-only",
        input: inputMetadata,
        output: outputMetadata,
        outputPath: output.finalPath,
        sizeBytes,
        audioEncoder: AUDIO_ENCODER,
        bitRate: AUDIO_BIT_RATE_BPS,
        sourceAudioStreamIndex: inputAudio.index,
        channels: outputAudio.channels,
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

export const extractAudioToM4a = createAudioExtractor({
  runProcess: runMediaProcess,
  probeMedia: probeMediaFile,
  getAllowedRoot: () => normalizeStorageRoot(env.storagePath),
  timeoutMs: env.ffmpegTimeoutSeconds * 1000,
  maxOutputBytes: Math.max(1, Math.floor(env.maxFileSizeMb * 1024 * 1024)),
  maxDurationSeconds: env.maxVideoDurationMinutes * 60,
  threads: env.ffmpegThreads
});
