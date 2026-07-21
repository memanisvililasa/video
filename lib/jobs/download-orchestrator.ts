import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import type { Extractor } from "@/lib/extractors/types";
import { canonicalizePlatformSourceInput } from "@/lib/extractors/platform-url";
import { requireExtractor } from "@/lib/extractors/registry";
import { extractAudioToM4a } from "@/lib/ffmpeg/audio";
import { convertMediaToCompatibleMp4 } from "@/lib/ffmpeg/convert";
import {
  assertMediaProbeLimits,
  DEFAULT_MEDIA_PROBE_LIMITS,
  probeMediaFile,
  type ProbeMediaFileOptions
} from "@/lib/ffmpeg/probe";
import { remuxMediaToMp4 } from "@/lib/ffmpeg/remux";
import type {
  AudioExtractionOptions,
  AudioExtractionResult,
  CompatibleMp4Options,
  CompatibleMp4Result,
  MediaProbeResult,
  ProcessingPreset,
  RemuxMediaOptions,
  RemuxMediaResult
} from "@/lib/ffmpeg/types";
import type {
  EnqueuedMediaJob,
  MediaJobOutputMetadata,
  MediaJobResult,
  MediaJobSnapshot
} from "@/lib/jobs/types";
import type { MediaJobRuntime } from "@/lib/jobs/runtime";
import { cleanupExpiredFiles, type CleanupExpiredFilesOptions } from "@/lib/storage/cleanup";
import {
  createJobArtifactLifecycle,
  type CreateJobArtifactLifecycleOptions,
  type JobArtifactLifecycle
} from "@/lib/storage/job-artifacts";
import { validateVideoUrl, type UrlValidation } from "@/lib/security/url-validation";
import { API_ERROR_CODES } from "@/lib/types";

const FORMAT_ID = /^[a-zA-Z0-9._-]{1,64}$/;
const PROCESSING_PRESETS = new Set<ProcessingPreset>([
  "original",
  "remux-to-mp4",
  "compatible-mp4",
  "audio-only"
]);

export type EnqueueDownloadJobRequest = {
  url: string;
  formatId: string;
  processingPreset: ProcessingPreset;
  rightsConfirmed: boolean;
};

type ProbeMedia = (inputPath: string, options?: ProbeMediaFileOptions) => Promise<MediaProbeResult>;
type RemuxMedia = (options: RemuxMediaOptions) => Promise<RemuxMediaResult>;
type ConvertMedia = (options: CompatibleMp4Options) => Promise<CompatibleMp4Result>;
type ExtractAudio = (options: AudioExtractionOptions) => Promise<AudioExtractionResult>;

export type DownloadOrchestrationDependencies = {
  jobs: MediaJobRuntime;
  validateUrl: (value: unknown) => UrlValidation;
  getExtractor: (url: URL) => Extractor;
  cleanupExpiredFiles: (options?: CleanupExpiredFilesOptions) => Promise<unknown>;
  createArtifacts: (options: CreateJobArtifactLifecycleOptions) => Promise<JobArtifactLifecycle>;
  probeMedia: ProbeMedia;
  remuxMedia: RemuxMedia;
  convertMedia: ConvertMedia;
  extractAudio: ExtractAudio;
  maxFileSizeBytes: number;
  maxDurationSeconds: number;
  metadataTimeoutSeconds: number;
  downloadTimeoutSeconds: number;
};

export type DownloadOrchestrationService = {
  enqueueDownloadJob: (request: EnqueueDownloadJobRequest) => Promise<EnqueuedMediaJob>;
  getDownloadJob: (jobId: string) => Promise<MediaJobSnapshot>;
  cancelDownloadJob: (jobId: string) => Promise<MediaJobSnapshot>;
};

function invalidRequestError(message: string): AppError {
  return new AppError(API_ERROR_CODES.INVALID_URL, message, 400);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError(API_ERROR_CODES.JOB_CANCELLED);
}

function validateRequest(request: EnqueueDownloadJobRequest): void {
  if (!request || typeof request !== "object") throw invalidRequestError("Некорректный запрос загрузки.");
  if (request.rightsConfirmed !== true) throw invalidRequestError("Необходимо подтвердить права на загрузку файла.");
  if (!PROCESSING_PRESETS.has(request.processingPreset)) throw invalidRequestError("Неизвестный режим обработки.");
  if (typeof request.formatId !== "string" || !FORMAT_ID.test(request.formatId)) {
    throw invalidRequestError("Укажите корректный formatId.");
  }
  if (typeof request.url !== "string") throw invalidRequestError("Укажите ссылку на видео.");
}

async function protectedJobIds(jobs: MediaJobRuntime): Promise<ReadonlySet<string>> {
  return new Set(
    (await jobs.listJobs())
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.jobId)
  );
}

function safeOutputMetadata(metadata: MediaProbeResult): MediaJobOutputMetadata {
  return Object.freeze({
    durationSeconds: metadata.durationSeconds,
    formatName: metadata.formatName,
    hasVideo: metadata.videoStreams.some((stream) => stream.attachedPicture !== true),
    hasAudio: metadata.audioStreams.length > 0,
    ...(metadata.width !== undefined ? { width: metadata.width } : {}),
    ...(metadata.height !== undefined ? { height: metadata.height } : {}),
    ...(metadata.videoCodec ? { videoCodec: metadata.videoCodec } : {}),
    ...(metadata.audioCodec ? { audioCodec: metadata.audioCodec } : {})
  });
}

function assertInputLimits(metadata: MediaProbeResult, maxDurationSeconds: number): void {
  assertMediaProbeLimits(metadata, {
    maxDurationSeconds,
    maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
    maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
  });
}

function usesFreshPlatformSources(extractor: Extractor): boolean {
  return extractor.id === "vimeo" || extractor.id === "youtube" || extractor.id === "reddit";
}

export function createDownloadOrchestrationService(
  dependencies: DownloadOrchestrationDependencies
): DownloadOrchestrationService {
  if (!Number.isSafeInteger(dependencies.maxFileSizeBytes) || dependencies.maxFileSizeBytes <= 0) {
    throw new TypeError("Download orchestration maxFileSizeBytes must be a positive integer.");
  }
  if (!Number.isFinite(dependencies.maxDurationSeconds) || dependencies.maxDurationSeconds < 0) {
    throw new TypeError("Download orchestration maxDurationSeconds must be non-negative.");
  }

  function enqueueDownloadJob(request: EnqueueDownloadJobRequest): Promise<EnqueuedMediaJob> {
    validateRequest(request);
    const initialValidation = dependencies.validateUrl(request.url);
    if (!initialValidation.ok) {
      throw new AppError(initialValidation.code, initialValidation.message);
    }
    const canonicalUrl = canonicalizePlatformSourceInput(request.url, initialValidation.url);
    const extractorId = dependencies.getExtractor(canonicalUrl).id;
    if (extractorId === "tiktok" || extractorId === "instagram" || extractorId === "facebook" || extractorId === "x") {
      throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL);
    }
    const trustedRequest = Object.freeze({
      url: canonicalUrl.toString(),
      formatId: request.formatId,
      processingPreset: request.processingPreset,
      rightsConfirmed: true as const
    });
    let artifacts: JobArtifactLifecycle | undefined;

    return dependencies.jobs.enqueue({
      processingPreset: trustedRequest.processingPreset,
      onDiscard: async () => artifacts?.discard(),
      handler: async (job, signal, updateProgress): Promise<MediaJobResult> => {
        try {
          assertNotAborted(signal);
          const validation = dependencies.validateUrl(trustedRequest.url);
          if (!validation.ok) {
            throw new AppError(validation.code, validation.message);
          }
          const url = validation.url;
          const extractor = dependencies.getExtractor(url);
          updateProgress(5);
          await dependencies.cleanupExpiredFiles({
            protectedJobIds: await protectedJobIds(dependencies.jobs)
          });

          assertNotAborted(signal);
          updateProgress(10);
          const metadata = await extractor.extract(url, {
            signal,
            metadataTimeoutSeconds: dependencies.metadataTimeoutSeconds,
            maxFileSizeBytes: dependencies.maxFileSizeBytes,
            maxDurationSeconds: dependencies.maxDurationSeconds
          });
          assertNotAborted(signal);
          const selectedFormat = metadata.formats.find((format) => format.id === trustedRequest.formatId);
          if (!selectedFormat) {
            throw new AppError(
              usesFreshPlatformSources(extractor)
                ? API_ERROR_CODES.SOURCE_EXPIRED
                : API_ERROR_CODES.UNSUPPORTED_URL,
              usesFreshPlatformSources(extractor)
                ? undefined
                : "Запрошенный формат недоступен для этой ссылки."
            );
          }
          updateProgress(15);

          artifacts = await dependencies.createArtifacts({
            jobId: job.jobId,
            maxFileSizeBytes: dependencies.maxFileSizeBytes
          });
          assertNotAborted(signal);
          updateProgress(20);
          const downloaded = await extractor.download(url, selectedFormat.id, {
            workDir: artifacts.jobDirectory,
            signal,
            metadataTimeoutSeconds: dependencies.metadataTimeoutSeconds,
            downloadTimeoutSeconds: dependencies.downloadTimeoutSeconds,
            maxFileSizeBytes: dependencies.maxFileSizeBytes,
            maxDurationSeconds: dependencies.maxDurationSeconds,
            processingPreset: trustedRequest.processingPreset,
            onDownloadProgress(downloadedBytes, totalBytes) {
              if (
                typeof totalBytes !== "number" ||
                !Number.isSafeInteger(totalBytes) ||
                totalBytes <= 0 ||
                totalBytes > dependencies.maxFileSizeBytes
              ) {
                return;
              }
              const ratio = Math.min(1, Math.max(0, downloadedBytes / totalBytes));
              updateProgress(20 + ratio * 35);
            }
          });
          assertNotAborted(signal);
          const source = await artifacts.registerSource(downloaded);
          await dependencies.jobs.setSourceMetadata(job.jobId, {
            sourceId: source.registryId,
            filename: source.filename,
            sizeBytes: source.sizeBytes,
            contentType: source.contentType
          });
          updateProgress(55);

          const inputMetadata = await dependencies.probeMedia(source.path, { signal });
          assertInputLimits(inputMetadata, dependencies.maxDurationSeconds);
          assertNotAborted(signal);
          updateProgress(60);

          const finalPlan = artifacts.prepareFinal(trustedRequest.processingPreset, source);
          updateProgress(65);
          let outputMetadata: MediaProbeResult;
          let outputSizeBytes: number | undefined;

          switch (trustedRequest.processingPreset) {
            case "original":
              await artifacts.publishOriginal(source, finalPlan);
              outputMetadata = await dependencies.probeMedia(finalPlan.path, { signal });
              assertInputLimits(outputMetadata, dependencies.maxDurationSeconds);
              break;
            case "remux-to-mp4": {
              const result = await dependencies.remuxMedia({
                inputPath: source.path,
                outputPath: finalPlan.path,
                signal
              });
              if (result.outputPath !== finalPlan.path) throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
              outputMetadata = result.output;
              outputSizeBytes = result.sizeBytes;
              break;
            }
            case "compatible-mp4": {
              const result = await dependencies.convertMedia({
                inputPath: source.path,
                outputPath: finalPlan.path,
                signal
              });
              if (result.outputPath !== finalPlan.path) throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
              outputMetadata = result.output;
              outputSizeBytes = result.sizeBytes;
              break;
            }
            case "audio-only": {
              const result = await dependencies.extractAudio({
                inputPath: source.path,
                outputPath: finalPlan.path,
                signal
              });
              if (result.outputPath !== finalPlan.path) throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
              outputMetadata = result.output;
              outputSizeBytes = result.sizeBytes;
              break;
            }
            default: {
              const exhaustive: never = trustedRequest.processingPreset;
              throw exhaustive;
            }
          }

          assertNotAborted(signal);
          updateProgress(90);
          const stored = await artifacts.registerFinal(finalPlan, outputSizeBytes);
          assertNotAborted(signal);
          updateProgress(95);
          await artifacts.completeSuccess();
          assertNotAborted(signal);

          return {
            fileId: stored.id,
            downloadUrl: `/api/file/${stored.id}`,
            filename: stored.filename,
            sizeBytes: stored.sizeBytes,
            mimeType: stored.contentType,
            expiresAt: stored.expiresAt,
            processingPreset: trustedRequest.processingPreset,
            media: safeOutputMetadata(outputMetadata)
          };
        } catch (error) {
          await artifacts?.discard();
          throw error;
        }
      }
    });
  }

  return Object.freeze({
    enqueueDownloadJob,
    getDownloadJob: dependencies.jobs.getJob,
    cancelDownloadJob: dependencies.jobs.cancelJob
  });
}

export function createDefaultDownloadOrchestrationService(
  jobs: MediaJobRuntime
): DownloadOrchestrationService {
  const maxFileSizeBytes = Math.max(1, Math.floor(env.maxFileSizeMb * 1024 * 1024));
  return createDownloadOrchestrationService({
    jobs,
    validateUrl: validateVideoUrl,
    getExtractor: requireExtractor,
    cleanupExpiredFiles,
    createArtifacts: (options) => createJobArtifactLifecycle(options),
    probeMedia: probeMediaFile,
    remuxMedia: remuxMediaToMp4,
    convertMedia: convertMediaToCompatibleMp4,
    extractAudio: extractAudioToM4a,
    maxFileSizeBytes,
    maxDurationSeconds: env.maxVideoDurationMinutes * 60,
    metadataTimeoutSeconds: 10,
    downloadTimeoutSeconds: env.downloadTimeoutSeconds
  });
}
