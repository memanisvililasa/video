import "server-only";
import path from "node:path";
import { AppError } from "@/lib/errors";
import type { Extractor } from "@/lib/extractors/types";
import { createAudioExtractor } from "@/lib/ffmpeg/audio";
import { createCompatibleMp4Converter } from "@/lib/ffmpeg/convert";
import {
  assertMediaProbeLimits,
  createMediaProbe,
  DEFAULT_MEDIA_PROBE_LIMITS
} from "@/lib/ffmpeg/probe";
import { createMediaRemux } from "@/lib/ffmpeg/remux";
import type {
  MediaProbeResult,
  MediaProcessRunner,
  ProcessingPreset
} from "@/lib/ffmpeg/types";
import { sanitizeMediaJobWorkItem, type ClaimedMediaJob } from "@/lib/jobs/job-lease-queue";
import type { MediaJobOutputMetadata } from "@/lib/jobs/types";
import { validateVideoUrl } from "@/lib/security/url-validation";
import type { MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import { createMediaArtifactId, type MediaObjectStorage } from "@/lib/storage/media-storage";
import { normalizeDownloadFilename } from "@/lib/storage/path-safety";
import { API_ERROR_CODES } from "@/lib/types";
import type { OwnedJobLeaseSession } from "@/lib/worker/lease-session";
import type { WorkerProgressReporter } from "@/lib/worker/progress";

const SOURCE_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

type SourceExtension = "mp4" | "webm" | "mov";
type OutputExtension = SourceExtension | "m4a";

export type WorkerProcessorConfig = Readonly<{
  maxFileSizeBytes: number;
  maxOutputBytes: number;
  maxDurationSeconds: number;
  metadataTimeoutSeconds: number;
  downloadTimeoutSeconds: number;
  ffprobeTimeoutMs: number;
  ffmpegTimeoutMs: number;
  ffmpegThreads: number;
  finalTtlSeconds: number;
}>;

export type WorkerProcessorDependencies = Readonly<{
  storage: MediaObjectStorage;
  artifacts: MediaArtifactRepository;
  runProcess: MediaProcessRunner;
  getExtractor(url: URL): Extractor;
}>;

export type ProcessClaimContext = Readonly<{
  claimed: ClaimedMediaJob;
  session: OwnedJobLeaseSession;
  progress: WorkerProgressReporter;
}>;

export interface MediaWorkerProcessor {
  process(context: ProcessClaimContext): Promise<void>;
}

function sourceExtension(value: unknown): SourceExtension {
  if (typeof value !== "string" || !SOURCE_EXTENSIONS.has(value.toLowerCase())) {
    throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL);
  }
  return value.toLowerCase() as SourceExtension;
}

function outputDefinition(preset: ProcessingPreset, source: SourceExtension): Readonly<{
  extension: OutputExtension;
  contentType: string;
}> {
  if (preset === "original") {
    return Object.freeze({
      extension: source,
      contentType: source === "mp4" ? "video/mp4" : source === "webm" ? "video/webm" : "video/quicktime"
    });
  }
  if (preset === "audio-only") return Object.freeze({ extension: "m4a", contentType: "audio/mp4" });
  return Object.freeze({ extension: "mp4", contentType: "video/mp4" });
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

function attemptRootFromWorkspace(sourcePath: string, stagedPath: string): string {
  const sourceRoot = path.dirname(path.dirname(sourcePath));
  const stagedRoot = path.dirname(path.dirname(stagedPath));
  if (sourceRoot !== stagedRoot || !path.isAbsolute(sourceRoot)) {
    throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
  }
  return sourceRoot;
}

export function createMediaWorkerProcessor(
  dependencies: WorkerProcessorDependencies,
  config: WorkerProcessorConfig
): MediaWorkerProcessor {
  async function cleanupAttempt(session: OwnedJobLeaseSession): Promise<void> {
    const { jobId, attemptId } = session.currentLease();
    const records = await dependencies.artifacts.listForJob(jobId).catch(() => []);
    for (const artifact of records) {
      if (artifact.attemptId !== attemptId || artifact.publicationState === "published") continue;
      await dependencies.storage.remove(artifact.storageKey).catch(() => false);
      await dependencies.artifacts.delete(artifact.artifactId, artifact.version).catch(() => undefined);
    }
    await dependencies.storage.removeAttemptWorkspace(jobId, attemptId).catch(() => false);
  }

  async function process(context: ProcessClaimContext): Promise<void> {
    const { claimed, session, progress } = context;
    let workspaceCreated = false;
    try {
      const payload = sanitizeMediaJobWorkItem(claimed.workItem);
      const validation = validateVideoUrl(payload.sourceUrl);
      if (!validation.ok) throw new AppError(validation.code);
      const extractor = dependencies.getExtractor(validation.url);
      const extracted = await extractor.extract(validation.url, {
        signal: session.signal,
        metadataTimeoutSeconds: config.metadataTimeoutSeconds,
        maxFileSizeBytes: config.maxFileSizeBytes
      });
      session.assertActive();
      const selected = extracted.formats.find((format) => format.id === payload.formatId);
      if (!selected) throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL);
      const inputExtension = sourceExtension(selected.ext);
      const output = outputDefinition(payload.processingPreset, inputExtension);
      await progress.flush(5);

      const workspace = await dependencies.storage.createAttemptWorkspace({
        jobId: claimed.record.jobId,
        attemptId: claimed.lease.attemptId,
        sourceExtension: inputExtension,
        outputExtension: output.extension
      });
      workspaceCreated = true;
      const attemptRoot = attemptRootFromWorkspace(workspace.source.localPath, workspace.stagedFinal.localPath);
      await progress.flush(10);

      const downloaded = await extractor.download(validation.url, selected.id, {
        workDir: path.dirname(workspace.source.localPath),
        signal: session.signal,
        metadataTimeoutSeconds: config.metadataTimeoutSeconds,
        downloadTimeoutSeconds: config.downloadTimeoutSeconds,
        maxFileSizeBytes: config.maxFileSizeBytes,
        onDownloadProgress(downloadedBytes, totalBytes) {
          if (!Number.isSafeInteger(totalBytes) || (totalBytes as number) <= 0 || (totalBytes as number) > config.maxFileSizeBytes) return;
          const ratio = Math.min(1, Math.max(0, downloadedBytes / (totalBytes as number)));
          progress.report(10 + ratio * 40);
        }
      });
      session.assertActive();
      if (downloaded.path !== workspace.source.localPath) {
        throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
      }
      const sourceObject = await dependencies.storage.inspect(workspace.source.key, config.maxFileSizeBytes);
      if (downloaded.sizeBytes !== sourceObject.sizeBytes) throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
      const sourceId = createMediaArtifactId("source");
      const sourceReservation = await session.reserveArtifact({
        artifactId: sourceId,
        kind: "source",
        object: sourceObject,
        filename: downloaded.filename,
        contentType: downloaded.contentType,
        ttlSeconds: config.finalTtlSeconds
      });
      if (sourceReservation.outcome !== "reserved" && sourceReservation.outcome !== "already-reserved") {
        throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
      }
      await session.setSourceMetadata({
        sourceId,
        filename: downloaded.filename,
        sizeBytes: sourceObject.sizeBytes,
        contentType: downloaded.contentType
      });
      await progress.flush(55);

      const probe = createMediaProbe({
        runProcess: dependencies.runProcess,
        getAllowedRoot: () => attemptRoot,
        timeoutMs: config.ffprobeTimeoutMs,
        maxDurationSeconds: config.maxDurationSeconds
      });
      const inputMetadata = await probe(workspace.source.localPath, { signal: session.signal });
      assertMediaProbeLimits(inputMetadata, {
        maxDurationSeconds: config.maxDurationSeconds,
        maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
        maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
      });
      await progress.flush(60);
      session.assertActive();

      await progress.flush(65);
      let outputMetadata: MediaProbeResult;
      if (payload.processingPreset === "original") {
        await dependencies.storage.stageOriginal({
          sourceKey: workspace.source.key,
          stagedKey: workspace.stagedFinal.key,
          maximumBytes: config.maxOutputBytes
        });
        outputMetadata = await probe(workspace.stagedFinal.localPath, { signal: session.signal });
      } else if (payload.processingPreset === "remux-to-mp4") {
        const remux = createMediaRemux({
          runProcess: dependencies.runProcess,
          probeMedia: probe,
          getAllowedRoot: () => attemptRoot,
          timeoutMs: config.ffmpegTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
          outputDirectoryPolicy: "same-root"
        });
        const result = await remux({
          inputPath: workspace.source.localPath,
          outputPath: workspace.stagedFinal.localPath,
          signal: session.signal
        });
        if (result.outputPath !== workspace.stagedFinal.localPath) throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
        outputMetadata = result.output;
      } else if (payload.processingPreset === "compatible-mp4") {
        const convert = createCompatibleMp4Converter({
          runProcess: dependencies.runProcess,
          probeMedia: probe,
          getAllowedRoot: () => attemptRoot,
          timeoutMs: config.ffmpegTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
          maxDurationSeconds: config.maxDurationSeconds,
          threads: config.ffmpegThreads,
          outputDirectoryPolicy: "same-root"
        });
        const result = await convert({
          inputPath: workspace.source.localPath,
          outputPath: workspace.stagedFinal.localPath,
          signal: session.signal
        });
        if (result.outputPath !== workspace.stagedFinal.localPath) throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
        outputMetadata = result.output;
      } else {
        const audio = createAudioExtractor({
          runProcess: dependencies.runProcess,
          probeMedia: probe,
          getAllowedRoot: () => attemptRoot,
          timeoutMs: config.ffmpegTimeoutMs,
          maxOutputBytes: config.maxOutputBytes,
          maxDurationSeconds: config.maxDurationSeconds,
          threads: config.ffmpegThreads,
          outputDirectoryPolicy: "same-root"
        });
        const result = await audio({
          inputPath: workspace.source.localPath,
          outputPath: workspace.stagedFinal.localPath,
          signal: session.signal
        });
        if (result.outputPath !== workspace.stagedFinal.localPath) throw new AppError(API_ERROR_CODES.PROCESSING_FAILED);
        outputMetadata = result.output;
      }
      session.assertActive();
      assertMediaProbeLimits(outputMetadata, {
        maxDurationSeconds: config.maxDurationSeconds,
        maxPixels: DEFAULT_MEDIA_PROBE_LIMITS.maxPixels,
        maxDimension: DEFAULT_MEDIA_PROBE_LIMITS.maxDimension
      });
      await progress.flush(90);

      const stagedObject = await dependencies.storage.inspect(workspace.stagedFinal.key, config.maxOutputBytes);
      const finalId = createMediaArtifactId("final");
      const finalFilename = normalizeDownloadFilename(downloaded.filename, output.extension);
      await session.reserveArtifact({
        artifactId: finalId,
        kind: "final",
        object: stagedObject,
        filename: finalFilename,
        contentType: output.contentType,
        ttlSeconds: config.finalTtlSeconds
      });
      await progress.flush(94);
      await session.verifyOwnership();

      const publishedObject = await dependencies.storage.publishImmutable({
        stagedKey: workspace.stagedFinal.key,
        fileId: finalId,
        extension: output.extension,
        maximumBytes: config.maxOutputBytes
      });
      await progress.flush(98);
      await session.completeReady({
        artifactId: finalId,
        publishedObject,
        media: safeOutputMetadata(outputMetadata)
      });
    } finally {
      if (workspaceCreated) await cleanupAttempt(session);
    }
  }

  return Object.freeze({ process });
}
