import "server-only";
import { AppError } from "@/lib/errors";
import type { TikTokMediaAdapter } from "@/lib/extractors/tiktok-media";
import {
  assertMediaProbeLimits,
  DEFAULT_MEDIA_PROBE_LIMITS,
  type ProbeMediaFileOptions
} from "@/lib/ffmpeg/probe";
import type {
  CompatibleMp4Options,
  CompatibleMp4Result,
  MediaProbeResult
} from "@/lib/ffmpeg/types";
import type {
  CreateJobArtifactLifecycleOptions,
  JobArtifactLifecycle
} from "@/lib/storage/job-artifacts";
import type { StoredFile } from "@/lib/storage/types";
import { API_ERROR_CODES } from "@/lib/types";

export type TikTokInternalPreset = "original" | "compatible-mp4";

export type TikTokInternalPipelineResult = Readonly<{
  fileId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: string;
  preset: TikTokInternalPreset;
  media: Readonly<{
    durationSeconds: number;
    width: number;
    height: number;
    hasAudio: boolean;
    videoCodec?: string;
    audioCodec?: string;
  }>;
}>;

type ProbeMedia = (path: string, options?: ProbeMediaFileOptions) => Promise<MediaProbeResult>;
type ConvertMedia = (options: CompatibleMp4Options) => Promise<CompatibleMp4Result>;

export type CreateTikTokInternalPipelineOptions = Readonly<{
  adapter: TikTokMediaAdapter;
  createArtifacts: (options: CreateJobArtifactLifecycleOptions) => Promise<JobArtifactLifecycle>;
  probeMedia: ProbeMedia;
  convertMedia: ConvertMedia;
  maxFileSizeBytes: number;
  maxDurationSeconds: number;
  metadataTimeoutSeconds: number;
  downloadTimeoutSeconds: number;
}>;

function processingFailed(): AppError {
  return new AppError(API_ERROR_CODES.OUTPUT_INVALID);
}

function playableVideo(metadata: MediaProbeResult) {
  return metadata.videoStreams.filter((stream) => stream.attachedPicture !== true);
}

function assertMedia(
  metadata: MediaProbeResult,
  maxDurationSeconds: number,
  expected?: Readonly<{ width: number; height: number }>
): void {
  assertMediaProbeLimits(metadata, {
    maxDurationSeconds,
    maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
    maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
  });
  const videos = playableVideo(metadata);
  if (videos.length !== 1 || !metadata.containerFormats.includes("mp4")) throw processingFailed();
  const video = videos[0];
  if (!video.width || !video.height) throw processingFailed();
  if (expected) {
    const exact = video.width === expected.width && video.height === expected.height;
    const rotated = video.width === expected.height && video.height === expected.width &&
      (Math.abs(video.rotationDegrees ?? 0) === 90 || Math.abs(video.rotationDegrees ?? 0) === 270);
    if (!exact && !rotated) throw processingFailed();
  }
  const videoDuration = video.durationSeconds;
  const audioDuration = metadata.audioStreams[0]?.durationSeconds;
  if (videoDuration !== undefined && audioDuration !== undefined) {
    const tolerance = Math.max(1, metadata.durationSeconds * 0.02);
    if (Math.abs(videoDuration - audioDuration) > tolerance) throw processingFailed();
  }
}

function safeResult(file: StoredFile, preset: TikTokInternalPreset, metadata: MediaProbeResult): TikTokInternalPipelineResult {
  const video = playableVideo(metadata)[0];
  if (!video?.width || !video.height) throw processingFailed();
  return Object.freeze({
    fileId: file.id,
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    expiresAt: file.expiresAt,
    preset,
    media: Object.freeze({
      durationSeconds: metadata.durationSeconds,
      width: video.width,
      height: video.height,
      hasAudio: metadata.audioStreams.length > 0,
      ...(metadata.videoCodec ? { videoCodec: metadata.videoCodec } : {}),
      ...(metadata.audioCodec ? { audioCodec: metadata.audioCodec } : {})
    })
  });
}

export function createTikTokInternalPipeline(options: CreateTikTokInternalPipelineOptions) {
  if (!Number.isSafeInteger(options.maxFileSizeBytes) || options.maxFileSizeBytes < 1) {
    throw new TypeError("TikTok pipeline byte limit is invalid.");
  }
  if (!Number.isFinite(options.maxDurationSeconds) || options.maxDurationSeconds <= 0) {
    throw new TypeError("TikTok pipeline duration limit is invalid.");
  }
  return async function execute(input: Readonly<{
    jobId: string;
    url: URL;
    formatId: string;
    preset: TikTokInternalPreset;
    signal?: AbortSignal;
  }>): Promise<TikTokInternalPipelineResult> {
    if (input.preset !== "original" && input.preset !== "compatible-mp4") {
      throw new AppError(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
    }
    let artifacts: JobArtifactLifecycle | undefined;
    try {
      artifacts = await options.createArtifacts({
        jobId: input.jobId,
        maxFileSizeBytes: options.maxFileSizeBytes
      });
      const downloaded = await options.adapter.download(input.url, input.formatId, {
        workDir: artifacts.jobDirectory,
        signal: input.signal,
        metadataTimeoutSeconds: options.metadataTimeoutSeconds,
        downloadTimeoutSeconds: options.downloadTimeoutSeconds,
        maxFileSizeBytes: options.maxFileSizeBytes,
        maxDurationSeconds: options.maxDurationSeconds,
        processingPreset: input.preset
      });
      const source = await artifacts.registerSource(downloaded);
      const sourceMetadata = await options.probeMedia(source.path, { signal: input.signal });
      assertMedia(sourceMetadata, options.maxDurationSeconds, downloaded.format);
      const finalPlan = artifacts.prepareFinal(input.preset, source);
      let finalMetadata: MediaProbeResult;
      let finalSize: number | undefined;
      if (input.preset === "original") {
        await artifacts.publishOriginal(source, finalPlan);
        finalMetadata = await options.probeMedia(finalPlan.path, { signal: input.signal });
        assertMedia(finalMetadata, options.maxDurationSeconds, downloaded.format);
      } else {
        const converted = await options.convertMedia({
          inputPath: source.path,
          outputPath: finalPlan.path,
          signal: input.signal
        });
        if (converted.outputPath !== finalPlan.path) throw processingFailed();
        finalMetadata = converted.output;
        finalSize = converted.sizeBytes;
        assertMedia(finalMetadata, options.maxDurationSeconds);
      }
      const stored = await artifacts.registerFinal(finalPlan, finalSize);
      await artifacts.completeSuccess();
      return safeResult(stored, input.preset, finalMetadata);
    } catch (error) {
      await artifacts?.discard();
      if (input.signal?.aborted) throw new AppError(API_ERROR_CODES.JOB_CANCELLED);
      if (error instanceof AppError) throw new AppError(error.code);
      throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
    }
  };
}
