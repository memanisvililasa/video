import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import {
  MEDIA_PROCESS_OUTPUT_LIMITS,
  MediaProcessError,
  runMediaProcess
} from "@/lib/ffmpeg/process-runner";
import { prepareLocalMp4Output, type LocalMediaOutput } from "@/lib/ffmpeg/local-output";
import {
  probeMediaFile,
  resolveLocalMediaFile,
  type ProbeMediaFileOptions
} from "@/lib/ffmpeg/probe";
import type {
  MediaProbeResult,
  MediaProcessRunner,
  MediaVideoStream,
  RemuxMediaOptions,
  RemuxMediaResult
} from "@/lib/ffmpeg/types";
import { normalizeStorageRoot } from "@/lib/storage/path-safety";
import { API_ERROR_CODES } from "@/lib/types";

export type { RemuxMediaOptions, RemuxMediaResult } from "@/lib/ffmpeg/types";

const ALLOWED_DEMUXERS = "mov,matroska,webm";
const MP4_VIDEO_COPY_CODECS = new Set(["h264", "hevc", "av1", "vp9", "mpeg4"]);
const MP4_AUDIO_COPY_CODECS = new Set(["aac", "mp3", "ac3", "eac3", "alac", "opus"]);

type ProbeMedia = (inputPath: string, options?: ProbeMediaFileOptions) => Promise<MediaProbeResult>;

export type MediaRemuxDependencies = {
  runProcess: MediaProcessRunner;
  probeMedia: ProbeMedia;
  getAllowedRoot: () => string;
  timeoutMs: number;
  maxOutputBytes: number;
};

function processingFailedError(): AppError {
  return new AppError(API_ERROR_CODES.PROCESSING_FAILED);
}

function invalidVideoInputError(): AppError {
  return new AppError(
    API_ERROR_CODES.INVALID_MEDIA_FILE,
    "Для remux в MP4 требуется корректный видеопоток."
  );
}

function unsupportedCodecError(): AppError {
  return new AppError(API_ERROR_CODES.UNSUPPORTED_CODEC);
}

function playableVideoStreams(metadata: MediaProbeResult): readonly MediaVideoStream[] {
  return metadata.videoStreams.filter((stream) => stream.attachedPicture !== true);
}

function assertStreamCopyCompatibility(metadata: MediaProbeResult): void {
  const videoStreams = playableVideoStreams(metadata);
  if (videoStreams.length === 0) throw invalidVideoInputError();

  if (videoStreams.some((stream) => !MP4_VIDEO_COPY_CODECS.has(stream.codec))) {
    throw unsupportedCodecError();
  }

  if (metadata.audioStreams.some((stream) => !MP4_AUDIO_COPY_CODECS.has(stream.codec))) {
    throw unsupportedCodecError();
  }
}

function buildRemuxArguments(inputPath: string, partialOutputPath: string): readonly string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-n",
    "-protocol_whitelist", "file",
    "-format_whitelist", ALLOWED_DEMUXERS,
    "-i", inputPath,
    "-map", "0:V?",
    "-map", "0:a?",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-c:v", "copy",
    "-c:a", "copy",
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

function validateRemuxedMetadata(input: MediaProbeResult, output: MediaProbeResult): void {
  if (!output.containerFormats.includes("mp4")) throw processingFailedError();

  const inputVideos = playableVideoStreams(input);
  const outputVideos = playableVideoStreams(output);
  if (outputVideos.length !== inputVideos.length || output.audioStreams.length !== input.audioStreams.length) {
    throw processingFailedError();
  }

  for (const [index, inputStream] of inputVideos.entries()) {
    const outputStream = outputVideos[index];
    if (
      !outputStream ||
      outputStream.codec !== inputStream.codec ||
      outputStream.width !== inputStream.width ||
      outputStream.height !== inputStream.height
    ) {
      throw processingFailedError();
    }

    if (inputStream.frameRate) {
      if (!outputStream.frameRate) throw processingFailedError();
      const tolerance = Math.max(0.01, inputStream.frameRate.value * 0.001);
      if (!approximatelyEqual(inputStream.frameRate.value, outputStream.frameRate.value, tolerance)) {
        throw processingFailedError();
      }
    }
  }

  for (const [index, inputStream] of input.audioStreams.entries()) {
    if (output.audioStreams[index]?.codec !== inputStream.codec) throw processingFailedError();
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
      error.code === API_ERROR_CODES.FFMPEG_NOT_AVAILABLE
    ) {
      return error;
    }
  }
  return processingFailedError();
}

/** @internal Exported to inject fake process/probe implementations in unit tests. */
export function createMediaRemux(dependencies: MediaRemuxDependencies) {
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new TypeError("Remux timeoutMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(dependencies.maxOutputBytes) || dependencies.maxOutputBytes <= 0) {
    throw new TypeError("Remux maxOutputBytes must be a positive integer.");
  }

  return async function remuxMediaToMp4(options: RemuxMediaOptions): Promise<RemuxMediaResult> {
    let output: LocalMediaOutput | undefined;

    try {
      const inputFile = await resolveLocalMediaFile(options.inputPath, dependencies.getAllowedRoot);
      output = await prepareLocalMp4Output(
        options.outputPath,
        inputFile.realPath,
        dependencies.getAllowedRoot
      );

      const inputMetadata = await dependencies.probeMedia(inputFile.realPath, { signal: options.signal });
      assertStreamCopyCompatibility(inputMetadata);

      output.markProcessStarted();
      const processResult = await dependencies.runProcess({
        tool: "ffmpeg",
        args: buildRemuxArguments(inputFile.realPath, output.partialPath),
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
      await output.publish();
      const sizeBytes = await output.assertFinalFile(dependencies.maxOutputBytes);

      let outputMetadata: MediaProbeResult;
      try {
        outputMetadata = await dependencies.probeMedia(output.finalPath, { signal: options.signal });
      } catch (error) {
        throw mapOutputProbeError(error);
      }
      validateRemuxedMetadata(inputMetadata, outputMetadata);

      return {
        preset: "remux-to-mp4",
        input: inputMetadata,
        output: outputMetadata,
        outputPath: output.finalPath,
        sizeBytes,
        copiedVideoStreams: playableVideoStreams(inputMetadata).length,
        copiedAudioStreams: inputMetadata.audioStreams.length
      };
    } catch (error) {
      if (output) await output.cleanup();
      if (error instanceof MediaProcessError) throw mapMediaProcessError(error);
      if (error instanceof AppError) throw error;
      throw processingFailedError();
    }
  };
}

export const remuxMediaToMp4 = createMediaRemux({
  runProcess: runMediaProcess,
  probeMedia: probeMediaFile,
  getAllowedRoot: () => normalizeStorageRoot(env.storagePath),
  timeoutMs: env.ffmpegTimeoutSeconds * 1000,
  maxOutputBytes: Math.max(1, Math.floor(env.maxFileSizeMb * 1024 * 1024))
});
