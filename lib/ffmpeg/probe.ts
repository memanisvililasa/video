import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import {
  MEDIA_PROCESS_OUTPUT_LIMITS,
  MediaProcessError,
  runMediaProcess
} from "@/lib/ffmpeg/process-runner";
import type {
  MediaAudioStream,
  MediaProbeLimits,
  MediaProbeResult,
  MediaProcessRunner,
  MediaRational,
  MediaVideoStream
} from "@/lib/ffmpeg/types";
import { assertSafePath, normalizeStorageRoot } from "@/lib/storage/path-safety";
import { API_ERROR_CODES } from "@/lib/types";

export type {
  MediaAudioStream,
  MediaFormatInfo,
  MediaProbeLimits,
  MediaProbeResult,
  MediaStreamInfo,
  MediaVideoStream
} from "@/lib/ffmpeg/types";

const MAX_INPUT_PIXELS = 8_294_400;
const MAX_INPUT_DIMENSION = 3840;
const MAX_STREAMS = 16;
const MAX_TEXT_LENGTH = 128;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SAFE_MEDIA_IDENTIFIER = /^[a-zA-Z0-9_.-]+$/;
const ALLOWED_DEMUXERS = "mov,matroska,webm";

const FFPROBE_SHOW_ENTRIES = [
  "format=format_name,duration,size,bit_rate",
  "stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate,duration,sample_rate,channels,pix_fmt,sample_aspect_ratio,color_range,color_space,color_transfer,color_primaries",
  "stream_disposition=attached_pic",
  "stream_side_data=rotation"
].join(":");

export const DEFAULT_MEDIA_PROBE_LIMITS = Object.freeze({
  maxPixels: MAX_INPUT_PIXELS,
  maxDimension: MAX_INPUT_DIMENSION
});

export type ProbeMediaFileOptions = {
  signal?: AbortSignal;
};

export type MediaProbeDependencies = {
  runProcess: MediaProcessRunner;
  getAllowedRoot: () => string;
  timeoutMs: number;
  maxDurationSeconds: number;
};

export type LocalMediaFile = {
  realPath: string;
  sizeBytes: number;
};

function invalidLocalFileError(): AppError {
  return new AppError(
    API_ERROR_CODES.INVALID_MEDIA_FILE,
    "Локальный медиафайл недоступен или имеет недопустимый путь."
  );
}

function invalidMediaError(): AppError {
  return new AppError(
    API_ERROR_CODES.INVALID_MEDIA_FILE,
    "Файл повреждён или не содержит поддерживаемых аудио- или видеопотоков."
  );
}

function ffprobeFailedError(): AppError {
  return new AppError(API_ERROR_CODES.FFPROBE_FAILED);
}

function assertLexicalContainment(root: string, candidate: string): void {
  try {
    assertSafePath(root, candidate);
  } catch {
    throw invalidLocalFileError();
  }
}

/** @internal Shared by local-only media operations. */
export async function resolveLocalMediaFile(inputPath: string, getAllowedRoot: () => string): Promise<LocalMediaFile> {
  if (
    typeof inputPath !== "string" ||
    !inputPath ||
    inputPath.includes("\0") ||
    URL_SCHEME.test(inputPath) ||
    !path.isAbsolute(inputPath)
  ) {
    throw invalidLocalFileError();
  }

  let configuredRoot: string;
  try {
    configuredRoot = getAllowedRoot();
  } catch {
    throw ffprobeFailedError();
  }

  if (typeof configuredRoot !== "string" || !path.isAbsolute(configuredRoot) || configuredRoot.includes("\0")) {
    throw ffprobeFailedError();
  }

  const lexicalRoot = path.resolve(configuredRoot);
  assertLexicalContainment(lexicalRoot, inputPath);

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(lexicalRoot);
    const rootStats = await lstat(canonicalRoot);
    if (!rootStats.isDirectory()) throw new Error("Storage root is not a directory.");
  } catch {
    throw ffprobeFailedError();
  }

  try {
    const inputStats = await lstat(inputPath);
    if (inputStats.isSymbolicLink() || !inputStats.isFile() || inputStats.size <= 0) {
      throw invalidLocalFileError();
    }

    const canonicalInput = await realpath(inputPath);
    assertLexicalContainment(canonicalRoot, canonicalInput);

    const canonicalStats = await lstat(canonicalInput);
    if (canonicalStats.isSymbolicLink() || !canonicalStats.isFile() || canonicalStats.size <= 0) {
      throw invalidLocalFileError();
    }

    return { realPath: canonicalInput, sizeBytes: canonicalStats.size };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidLocalFileError();
  }
}

function buildFfprobeArguments(inputPath: string): readonly string[] {
  return [
    "-hide_banner",
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-show_entries", FFPROBE_SHOW_ENTRIES,
    "-protocol_whitelist", "file",
    "-format_whitelist", ALLOWED_DEMUXERS,
    "-max_streams", String(MAX_STREAMS),
    "-max_probe_packets", "2500",
    "-probesize", "10485760",
    "-analyzeduration", "10000000",
    inputPath
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiniteNumber(value: unknown, minimum = 0): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;

  const parsed = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : undefined;
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = parseFiniteNumber(value, 0);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseSafeInteger(value: unknown, minimum = 0): number | undefined {
  const parsed = parseFiniteNumber(value, minimum);
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function parseIdentifier(value: unknown): string {
  const parsed = parseText(value, 64);
  return parsed && SAFE_MEDIA_IDENTIFIER.test(parsed) ? parsed : "unknown";
}

function parseRational(value: unknown, separator: "/" | ":" = "/"): MediaRational | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.trim().split(separator);
  if (parts.length !== 2) return undefined;

  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return undefined;
  }

  const normalized = numerator / denominator;
  if (!Number.isFinite(normalized) || normalized <= 0) return undefined;
  return { numerator, denominator, value: normalized };
}

function parseRotation(stream: Record<string, unknown>): number | undefined {
  if (!Array.isArray(stream.side_data_list)) return undefined;
  for (const item of stream.side_data_list.slice(0, MAX_STREAMS)) {
    if (!isRecord(item)) continue;
    const rotation = parseFiniteNumber(item.rotation, -3600);
    if (rotation !== undefined && Number.isSafeInteger(rotation) && rotation <= 3600) return rotation;
  }
  return undefined;
}

function parseVideoStream(stream: Record<string, unknown>, fallbackIndex: number): MediaVideoStream {
  const disposition = isRecord(stream.disposition) ? stream.disposition : {};
  return {
    index: parseSafeInteger(stream.index) ?? fallbackIndex,
    codec: parseIdentifier(stream.codec_name),
    width: parseSafeInteger(stream.width, 1),
    height: parseSafeInteger(stream.height, 1),
    attachedPicture: parseSafeInteger(disposition.attached_pic) === 1,
    frameRate: parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate),
    bitRate: parseSafeInteger(stream.bit_rate, 1),
    pixelFormat: parseText(stream.pix_fmt, 64),
    sampleAspectRatio: parseRational(stream.sample_aspect_ratio, ":"),
    rotationDegrees: parseRotation(stream),
    colorRange: parseText(stream.color_range, 64),
    colorSpace: parseText(stream.color_space, 64),
    colorTransfer: parseText(stream.color_transfer, 64),
    colorPrimaries: parseText(stream.color_primaries, 64),
    durationSeconds: parsePositiveNumber(stream.duration)
  };
}

function parseAudioStream(stream: Record<string, unknown>, fallbackIndex: number): MediaAudioStream {
  return {
    index: parseSafeInteger(stream.index) ?? fallbackIndex,
    codec: parseIdentifier(stream.codec_name),
    sampleRate: parseSafeInteger(stream.sample_rate, 1),
    channels: parseSafeInteger(stream.channels, 1),
    bitRate: parseSafeInteger(stream.bit_rate, 1),
    durationSeconds: parsePositiveNumber(stream.duration)
  };
}

function parseContainerFormats(format: Record<string, unknown>): readonly string[] {
  const formatName = parseText(format.format_name, 256);
  if (!formatName) return [];

  return formatName
    .split(",")
    .map((item) => item.trim())
    .filter((item) => SAFE_MEDIA_IDENTIFIER.test(item))
    .slice(0, MAX_STREAMS);
}

function parseProbeJson(stdout: string, localSizeBytes: number): MediaProbeResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw ffprobeFailedError();
  }

  if (!isRecord(value) || !Array.isArray(value.streams) || value.streams.length > MAX_STREAMS) {
    throw invalidMediaError();
  }

  const format = isRecord(value.format) ? value.format : {};
  const videoStreams: MediaVideoStream[] = [];
  const audioStreams: MediaAudioStream[] = [];

  for (const [streamIndex, stream] of value.streams.entries()) {
    if (!isRecord(stream)) continue;
    if (stream.codec_type === "video") videoStreams.push(parseVideoStream(stream, streamIndex));
    if (stream.codec_type === "audio") audioStreams.push(parseAudioStream(stream, streamIndex));
  }

  if (videoStreams.length === 0 && audioStreams.length === 0) throw invalidMediaError();
  if (videoStreams.some((stream) => stream.width === undefined || stream.height === undefined)) {
    throw invalidMediaError();
  }

  const durationCandidates = [
    parsePositiveNumber(format.duration),
    ...videoStreams.map((stream) => stream.durationSeconds),
    ...audioStreams.map((stream) => stream.durationSeconds)
  ].filter((duration): duration is number => duration !== undefined);

  if (durationCandidates.length === 0) throw invalidMediaError();

  const durationSeconds = Math.max(...durationCandidates);
  const containerFormats = parseContainerFormats(format);
  const formatName = containerFormats.length > 0 ? containerFormats.join(",") : "unknown";
  const sizeBytes = parseSafeInteger(format.size, 1) ?? localSizeBytes;
  const bitRate = parseSafeInteger(format.bit_rate, 1);
  const primaryVideo = videoStreams[0];
  const primaryAudio = audioStreams[0];

  return {
    durationSeconds,
    formatName,
    containerFormats,
    sizeBytes,
    bitRate,
    hasVideo: videoStreams.length > 0,
    hasAudio: audioStreams.length > 0,
    videoStreams,
    audioStreams,
    width: primaryVideo?.width,
    height: primaryVideo?.height,
    videoCodec: primaryVideo?.codec,
    audioCodec: primaryAudio?.codec,
    frameRate: primaryVideo?.frameRate,
    format: {
      formatName,
      containerFormats,
      durationSeconds,
      sizeBytes,
      bitRate
    }
  };
}

export function assertMediaProbeLimits(result: MediaProbeResult, limits: MediaProbeLimits): void {
  if (
    !Number.isFinite(limits.maxDurationSeconds) || limits.maxDurationSeconds < 0 ||
    !Number.isSafeInteger(limits.maxPixels) || limits.maxPixels <= 0 ||
    !Number.isSafeInteger(limits.maxDimension) || limits.maxDimension <= 0
  ) {
    throw new TypeError("Media probe limits are invalid.");
  }

  if (result.durationSeconds > limits.maxDurationSeconds) {
    throw new AppError(API_ERROR_CODES.VIDEO_TOO_LONG);
  }

  for (const stream of result.videoStreams) {
    const width = stream.width;
    const height = stream.height;
    if (width === undefined || height === undefined) throw invalidMediaError();

    const pixels = width * height;
    if (
      !Number.isSafeInteger(pixels) ||
      pixels > limits.maxPixels ||
      width > limits.maxDimension ||
      height > limits.maxDimension
    ) {
      throw new AppError(API_ERROR_CODES.VIDEO_RESOLUTION_TOO_HIGH);
    }
  }
}

function mapProcessError(error: MediaProcessError): AppError {
  switch (error.reason) {
    case "spawn":
      return new AppError(API_ERROR_CODES.FFMPEG_NOT_AVAILABLE);
    case "timeout":
      return new AppError(API_ERROR_CODES.PROCESSING_TIMEOUT);
    case "aborted":
      return new AppError(API_ERROR_CODES.JOB_CANCELLED);
    case "stdout-limit":
      return ffprobeFailedError();
    case "non-zero-exit":
      return invalidMediaError();
  }
}

/** @internal Exported to inject a fake process runner in unit tests. */
export function createMediaProbe(dependencies: MediaProbeDependencies) {
  return async function probeMediaFile(
    inputPath: string,
    options: ProbeMediaFileOptions = {}
  ): Promise<MediaProbeResult> {
    try {
      const localFile = await resolveLocalMediaFile(inputPath, dependencies.getAllowedRoot);
      const processResult = await dependencies.runProcess({
        tool: "ffprobe",
        args: buildFfprobeArguments(localFile.realPath),
        cwd: path.dirname(localFile.realPath),
        timeoutMs: dependencies.timeoutMs,
        signal: options.signal,
        stdout: {
          maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.ffprobeStdoutBytes,
          overflow: "terminate"
        },
        stderr: {
          maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.stderrBytes,
          overflow: "truncate-tail"
        }
      });

      if (processResult.stdoutTruncated) throw ffprobeFailedError();

      const result = parseProbeJson(processResult.stdout, localFile.sizeBytes);
      assertMediaProbeLimits(result, {
        maxDurationSeconds: dependencies.maxDurationSeconds,
        maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
        maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
      });
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof MediaProcessError) throw mapProcessError(error);
      throw ffprobeFailedError();
    }
  };
}

export const probeMediaFile = createMediaProbe({
  runProcess: runMediaProcess,
  getAllowedRoot: () => normalizeStorageRoot(env.storagePath),
  timeoutMs: env.ffprobeTimeoutSeconds * 1000,
  maxDurationSeconds: env.maxVideoDurationMinutes * 60
});

export const probeMedia = probeMediaFile;
