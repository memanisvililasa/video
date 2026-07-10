import { link, lstat, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import type { DownloadedSource } from "@/lib/extractors/types";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";
import { createFileId, createSourceId, getJobExpiresAt } from "@/lib/jobs/download-job";
import { deleteRegisteredFile, registerFile } from "@/lib/storage/file-registry";
import {
  ensureJobDirectory,
  getRelativeStoragePath,
  getStorageRoot
} from "@/lib/storage/local-storage";
import { assertSafePath, normalizeDownloadFilename, safeJoin } from "@/lib/storage/path-safety";
import type { StoredFile } from "@/lib/storage/types";
import { API_ERROR_CODES } from "@/lib/types";

const SOURCE_EXTENSIONS = new Set(["mp4", "webm", "mov"]);

export type RegisteredSourceArtifact = Readonly<{
  registryId: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  extension: "mp4" | "webm" | "mov";
}>;

export type FinalArtifactPlan = Readonly<{
  path: string;
  partialPath: string;
  extension: "mp4" | "webm" | "mov" | "m4a";
  mimeType: string;
  downloadFilename: string;
}>;

export type JobArtifactLifecycle = {
  jobDirectory: string;
  registerSource: (downloaded: DownloadedSource) => Promise<RegisteredSourceArtifact>;
  prepareFinal: (preset: ProcessingPreset, source: RegisteredSourceArtifact) => FinalArtifactPlan;
  publishOriginal: (source: RegisteredSourceArtifact, plan: FinalArtifactPlan) => Promise<void>;
  registerFinal: (plan: FinalArtifactPlan, sizeBytes?: number) => Promise<StoredFile>;
  completeSuccess: () => Promise<void>;
  discard: () => Promise<void>;
};

export type JobArtifactLifecycleDependencies = {
  ensureJobDirectory: (jobId: string) => Promise<string>;
  getStorageRoot: () => string;
  getRelativeStoragePath: (absolutePath: string) => string;
  registerFile: (file: StoredFile) => StoredFile;
  deleteRegisteredFile: (fileId: string) => boolean;
  createFileId: () => string;
  createSourceId: () => string;
  getExpiresAt: () => string;
  now: () => number;
};

export type CreateJobArtifactLifecycleOptions = {
  jobId: string;
  maxFileSizeBytes: number;
};

function downloadFailedError(): AppError {
  return new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
}

function processingFailedError(): AppError {
  return new AppError(API_ERROR_CODES.PROCESSING_FAILED);
}

async function validateRegularArtifact(
  candidate: string,
  canonicalJobDirectory: string,
  storageRoot: string,
  maxFileSizeBytes: number
): Promise<{ realPath: string; sizeBytes: number }> {
  try {
    const directStats = await lstat(candidate);
    if (directStats.isSymbolicLink() || !directStats.isFile() || directStats.size <= 0) throw processingFailedError();
    if (directStats.size > maxFileSizeBytes) throw new AppError(API_ERROR_CODES.OUTPUT_TOO_LARGE);

    const realPath = await realpath(candidate);
    assertSafePath(storageRoot, realPath);
    if (path.dirname(realPath) !== canonicalJobDirectory) throw processingFailedError();
    const canonicalStats = await lstat(realPath);
    if (canonicalStats.isSymbolicLink() || !canonicalStats.isFile() || canonicalStats.size <= 0) {
      throw processingFailedError();
    }
    if (canonicalStats.size > maxFileSizeBytes) throw new AppError(API_ERROR_CODES.OUTPUT_TOO_LARGE);
    return { realPath, sizeBytes: canonicalStats.size };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw processingFailedError();
  }
}

function getSourceExtension(candidate: string): "mp4" | "webm" | "mov" {
  const extension = path.extname(candidate).slice(1).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension)) throw downloadFailedError();
  return extension as "mp4" | "webm" | "mov";
}

function outputDefinition(preset: ProcessingPreset, sourceExtension: "mp4" | "webm" | "mov") {
  switch (preset) {
    case "original":
      return {
        extension: sourceExtension,
        mimeType: sourceExtension === "mp4"
          ? "video/mp4"
          : sourceExtension === "webm"
            ? "video/webm"
            : "video/quicktime"
      } as const;
    case "remux-to-mp4":
    case "compatible-mp4":
      return { extension: "mp4", mimeType: "video/mp4" } as const;
    case "audio-only":
      return { extension: "m4a", mimeType: "audio/mp4" } as const;
  }
}

export async function createJobArtifactLifecycle(
  options: CreateJobArtifactLifecycleOptions,
  dependencies: JobArtifactLifecycleDependencies = {
    ensureJobDirectory,
    getStorageRoot,
    getRelativeStoragePath,
    registerFile,
    deleteRegisteredFile,
    createFileId,
    createSourceId,
    getExpiresAt: getJobExpiresAt,
    now: Date.now
  }
): Promise<JobArtifactLifecycle> {
  if (!Number.isSafeInteger(options.maxFileSizeBytes) || options.maxFileSizeBytes <= 0) {
    throw new TypeError("Job artifact maxFileSizeBytes must be a positive integer.");
  }

  const createdDirectory = await dependencies.ensureJobDirectory(options.jobId);
  const storageRoot = await realpath(dependencies.getStorageRoot());
  const canonicalJobDirectory = await realpath(createdDirectory);
  assertSafePath(storageRoot, canonicalJobDirectory);
  const ownedPaths = new Set<string>();
  const registeredIds = new Set<string>();
  let sourceArtifact: RegisteredSourceArtifact | undefined;
  let finalPlan: FinalArtifactPlan | undefined;
  let finalStoredFile: StoredFile | undefined;
  let discarded = false;

  async function registerSource(downloaded: DownloadedSource): Promise<RegisteredSourceArtifact> {
    if (sourceArtifact) throw downloadFailedError();
    const extension = getSourceExtension(downloaded.path);
    const expectedPath = safeJoin(canonicalJobDirectory, `source.${extension}`);
    if (downloaded.path !== expectedPath) throw downloadFailedError();
    ownedPaths.add(expectedPath);
    ownedPaths.add(`${expectedPath}.download`);
    const validated = await validateRegularArtifact(
      downloaded.path,
      canonicalJobDirectory,
      storageRoot,
      options.maxFileSizeBytes
    );
    if (downloaded.sizeBytes !== validated.sizeBytes) throw downloadFailedError();

    ownedPaths.add(validated.realPath);
    const registryId = dependencies.createSourceId();
    const createdAt = new Date(dependencies.now()).toISOString();
    dependencies.registerFile({
      id: registryId,
      jobId: options.jobId,
      path: validated.realPath,
      relativePath: dependencies.getRelativeStoragePath(validated.realPath),
      filename: `source.${extension}`,
      sizeBytes: validated.sizeBytes,
      contentType: downloaded.contentType,
      createdAt,
      expiresAt: dependencies.getExpiresAt(),
      kind: "source"
    });
    registeredIds.add(registryId);
    sourceArtifact = Object.freeze({
      registryId,
      path: validated.realPath,
      filename: downloaded.filename,
      contentType: downloaded.contentType,
      sizeBytes: validated.sizeBytes,
      extension
    });
    return sourceArtifact;
  }

  function prepareFinal(preset: ProcessingPreset, source: RegisteredSourceArtifact): FinalArtifactPlan {
    if (sourceArtifact !== source || finalPlan) throw processingFailedError();
    const definition = outputDefinition(preset, source.extension);
    const finalPath = safeJoin(canonicalJobDirectory, `final.${definition.extension}`);
    const partialPath = safeJoin(canonicalJobDirectory, `final.partial.${definition.extension}`);
    finalPlan = Object.freeze({
      path: finalPath,
      partialPath,
      extension: definition.extension,
      mimeType: definition.mimeType,
      downloadFilename: normalizeDownloadFilename(source.filename, definition.extension)
    });
    return finalPlan;
  }

  async function publishOriginal(source: RegisteredSourceArtifact, plan: FinalArtifactPlan): Promise<void> {
    if (sourceArtifact !== source || finalPlan !== plan || plan.extension !== source.extension) {
      throw processingFailedError();
    }
    try {
      await link(source.path, plan.path);
      ownedPaths.add(plan.path);
      await validateRegularArtifact(plan.path, canonicalJobDirectory, storageRoot, options.maxFileSizeBytes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw processingFailedError();
    }
  }

  async function registerFinal(plan: FinalArtifactPlan, expectedSizeBytes?: number): Promise<StoredFile> {
    if (finalPlan !== plan || finalStoredFile) throw processingFailedError();
    const validated = await validateRegularArtifact(
      plan.path,
      canonicalJobDirectory,
      storageRoot,
      options.maxFileSizeBytes
    );
    ownedPaths.add(validated.realPath);
    if (expectedSizeBytes !== undefined && expectedSizeBytes !== validated.sizeBytes) throw processingFailedError();

    const fileId = dependencies.createFileId();
    const stored = dependencies.registerFile({
      id: fileId,
      jobId: options.jobId,
      path: validated.realPath,
      relativePath: dependencies.getRelativeStoragePath(validated.realPath),
      filename: plan.downloadFilename,
      sizeBytes: validated.sizeBytes,
      contentType: plan.mimeType,
      createdAt: new Date(dependencies.now()).toISOString(),
      expiresAt: dependencies.getExpiresAt(),
      kind: "final"
    });
    registeredIds.add(fileId);
    finalStoredFile = stored;
    return stored;
  }

  async function removeSource(): Promise<void> {
    if (!sourceArtifact) return;
    dependencies.deleteRegisteredFile(sourceArtifact.registryId);
    registeredIds.delete(sourceArtifact.registryId);
    await rm(sourceArtifact.path, { force: true }).catch(() => undefined);
    await rm(`${sourceArtifact.path}.download`, { force: true }).catch(() => undefined);
  }

  async function completeSuccess(): Promise<void> {
    if (!finalStoredFile) throw processingFailedError();
    await removeSource();
  }

  async function discard(): Promise<void> {
    if (discarded) return;
    discarded = true;
    for (const id of registeredIds) dependencies.deleteRegisteredFile(id);
    registeredIds.clear();
    await Promise.all([...ownedPaths].map((candidate) => rm(candidate, { force: true }).catch(() => undefined)));
    await rmdir(canonicalJobDirectory).catch(() => undefined);
  }

  return Object.freeze({
    jobDirectory: canonicalJobDirectory,
    registerSource,
    prepareFinal,
    publishOriginal,
    registerFinal,
    completeSuccess,
    discard
  });
}
