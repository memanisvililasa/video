import { rm } from "node:fs/promises";
import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import { requireExtractor } from "@/lib/extractors/registry";
import { createFileId, createJobId, createReadyJob, getJobExpiresAt } from "@/lib/jobs/download-job";
import { cleanupExpiredFiles } from "@/lib/storage/cleanup";
import { ensureJobDirectory, getRelativeStoragePath, savePreparedFile } from "@/lib/storage/local-storage";
import { API_ERROR_CODES, type DownloadFile, type DownloadJob, type DownloadRequest } from "@/lib/types";
import { validateVideoUrl } from "@/lib/security/url-validation";
import type { DownloadOrchestrationService } from "@/lib/jobs/download-orchestrator";
import type { CreateDownloadJobRequest } from "@/lib/api/media-job-dto";

let localOrchestrationPromise: Promise<DownloadOrchestrationService> | null = null;

function getLocalDownloadOrchestration(): Promise<DownloadOrchestrationService> {
  if (!localOrchestrationPromise) {
    localOrchestrationPromise = Promise.all([
      import("@/lib/jobs/download-orchestrator"),
      import("@/lib/jobs/queue")
    ]).then(([orchestration, queue]) =>
      orchestration.createDefaultDownloadOrchestrationService(queue.mediaJobRuntime)
    );
  }
  return localOrchestrationPromise;
}

export async function enqueueDownloadJob(request: CreateDownloadJobRequest) {
  return (await getLocalDownloadOrchestration()).enqueueDownloadJob(request);
}

export async function getDownloadJob(jobId: string) {
  return (await getLocalDownloadOrchestration()).getDownloadJob(jobId);
}

export async function cancelDownloadJob(jobId: string) {
  return (await getLocalDownloadOrchestration()).cancelDownloadJob(jobId);
}

export type PreparedDownload = {
  job: DownloadJob;
  file: DownloadFile;
};

function maxFileSizeBytes(): number {
  return env.maxFileSizeMb * 1024 * 1024;
}

export async function prepareDownload(request: DownloadRequest): Promise<PreparedDownload> {
  const validation = validateVideoUrl(request.url);
  if (!validation.ok) {
    throw new AppError(validation.code, validation.message, undefined, validation.error.details);
  }

  const extractor = requireExtractor(validation.url);
  const metadata = await extractor.extract(validation.url, {
    metadataTimeoutSeconds: 10,
    maxFileSizeBytes: maxFileSizeBytes()
  });

  const format = metadata.formats.find((candidate) => candidate.id === request.formatId);
  if (!format) {
    throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL, "Запрошенный формат недоступен для этой ссылки.", 400);
  }

  await cleanupExpiredFiles();

  const jobId = createJobId();
  const fileId = createFileId();
  const createdAt = new Date().toISOString();
  const expiresAt = getJobExpiresAt();
  const jobDirectory = await ensureJobDirectory(jobId);

  try {
    const downloaded = await extractor.download(validation.url, format.id, {
      workDir: jobDirectory,
      metadataTimeoutSeconds: 10,
      downloadTimeoutSeconds: env.downloadTimeoutSeconds,
      maxFileSizeBytes: maxFileSizeBytes()
    });

    const storedFile = await savePreparedFile({
      id: fileId,
      jobId,
      path: downloaded.path,
      relativePath: getRelativeStoragePath(downloaded.path),
      filename: downloaded.filename,
      sizeBytes: downloaded.sizeBytes,
      contentType: downloaded.contentType,
      createdAt,
      expiresAt
    });

    return {
      job: createReadyJob(jobId, fileId, createdAt, expiresAt),
      file: {
        id: storedFile.id,
        downloadUrl: `/api/file/${storedFile.id}`,
        filename: storedFile.filename,
        sizeBytes: storedFile.sizeBytes,
        contentType: storedFile.contentType,
        expiresAt: storedFile.expiresAt
      }
    };
  } catch (error) {
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
