import { link, lstat, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { assertSafePath, safeJoin } from "@/lib/storage/path-safety";
import { API_ERROR_CODES } from "@/lib/types";

const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SAFE_OUTPUT_BASENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,135}$/;

type LocalMediaOutputExtension = "mp4" | "m4a";
export type LocalMediaOutputDirectoryPolicy = "same-directory" | "same-root";

export type LocalMediaOutput = {
  finalPath: string;
  partialPath: string;
  jobDirectory: string;
  markProcessStarted: () => void;
  assertPartialFile: (maxOutputBytes: number) => Promise<number>;
  publish: () => Promise<void>;
  assertFinalFile: (maxOutputBytes: number) => Promise<number>;
  cleanup: () => Promise<void>;
};

function processingFailedError(): AppError {
  return new AppError(API_ERROR_CODES.PROCESSING_FAILED);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function assertContained(root: string, candidate: string): void {
  try {
    assertSafePath(root, candidate);
  } catch {
    throw processingFailedError();
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw processingFailedError();
  }
}

async function assertRegularNonEmptyFile(candidate: string, maxOutputBytes: number): Promise<number> {
  let stats;
  try {
    stats = await lstat(candidate);
  } catch {
    throw processingFailedError();
  }

  if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0) throw processingFailedError();
  if (stats.size > maxOutputBytes) throw new AppError(API_ERROR_CODES.OUTPUT_TOO_LARGE);
  return stats.size;
}

async function prepareLocalMediaOutput(
  outputPath: string,
  inputRealPath: string,
  getAllowedRoot: () => string,
  extension: LocalMediaOutputExtension,
  directoryPolicy: LocalMediaOutputDirectoryPolicy
): Promise<LocalMediaOutput> {
  if (directoryPolicy !== "same-directory" && directoryPolicy !== "same-root") {
    throw processingFailedError();
  }
  if (
    typeof outputPath !== "string" ||
    !outputPath ||
    outputPath.includes("\0") ||
    URL_SCHEME.test(outputPath) ||
    !path.isAbsolute(outputPath) ||
    path.normalize(outputPath) !== outputPath
  ) {
    throw processingFailedError();
  }

  const filename = path.basename(outputPath);
  const expectedExtension = `.${extension}`;
  const basename = filename.slice(0, -expectedExtension.length);
  if (path.extname(filename) !== expectedExtension || !SAFE_OUTPUT_BASENAME.test(basename)) {
    throw processingFailedError();
  }

  let configuredRoot: string;
  try {
    configuredRoot = getAllowedRoot();
  } catch {
    throw processingFailedError();
  }

  if (typeof configuredRoot !== "string" || !path.isAbsolute(configuredRoot) || configuredRoot.includes("\0")) {
    throw processingFailedError();
  }

  const lexicalRoot = path.resolve(configuredRoot);
  assertContained(lexicalRoot, outputPath);

  let canonicalRoot: string;
  let canonicalOutputDirectory: string;
  try {
    canonicalRoot = await realpath(lexicalRoot);
    canonicalOutputDirectory = await realpath(path.dirname(outputPath));
    const [rootStats, directoryStats] = await Promise.all([
      lstat(canonicalRoot),
      lstat(canonicalOutputDirectory)
    ]);
    if (!rootStats.isDirectory() || !directoryStats.isDirectory()) throw processingFailedError();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw processingFailedError();
  }

  assertContained(canonicalRoot, canonicalOutputDirectory);
  if (directoryPolicy === "same-directory" && canonicalOutputDirectory !== path.dirname(inputRealPath)) {
    throw processingFailedError();
  }

  let finalPath: string;
  let partialPath: string;
  try {
    finalPath = safeJoin(canonicalOutputDirectory, filename);
    partialPath = safeJoin(canonicalOutputDirectory, `${basename}.partial.${extension}`);
  } catch {
    throw processingFailedError();
  }

  if (finalPath === inputRealPath || partialPath === inputRealPath || finalPath === partialPath) {
    throw processingFailedError();
  }

  const [finalExists, partialExists] = await Promise.all([
    pathExists(finalPath),
    pathExists(partialPath)
  ]);
  if (finalExists || partialExists) throw processingFailedError();

  let processStarted = false;
  let finalOwned = false;

  return {
    finalPath,
    partialPath,
    jobDirectory: canonicalOutputDirectory,
    markProcessStarted() {
      processStarted = true;
    },
    assertPartialFile(maxOutputBytes: number) {
      return assertRegularNonEmptyFile(partialPath, maxOutputBytes);
    },
    async publish() {
      try {
        await link(partialPath, finalPath);
        finalOwned = true;
        await unlink(partialPath);
      } catch {
        throw processingFailedError();
      }
    },
    assertFinalFile(maxOutputBytes: number) {
      return assertRegularNonEmptyFile(finalPath, maxOutputBytes);
    },
    async cleanup() {
      const removals: Promise<unknown>[] = [];
      if (processStarted) removals.push(rm(partialPath, { force: true }).catch(() => undefined));
      if (finalOwned) removals.push(rm(finalPath, { force: true }).catch(() => undefined));
      await Promise.all(removals);
    }
  };
}

/** @internal Shared MP4 output lifecycle for trusted local FFmpeg operations. */
export function prepareLocalMp4Output(
  outputPath: string,
  inputRealPath: string,
  getAllowedRoot: () => string,
  directoryPolicy: LocalMediaOutputDirectoryPolicy = "same-directory"
): Promise<LocalMediaOutput> {
  return prepareLocalMediaOutput(outputPath, inputRealPath, getAllowedRoot, "mp4", directoryPolicy);
}

/** @internal Shared M4A output lifecycle for trusted local FFmpeg operations. */
export function prepareLocalM4aOutput(
  outputPath: string,
  inputRealPath: string,
  getAllowedRoot: () => string,
  directoryPolicy: LocalMediaOutputDirectoryPolicy = "same-directory"
): Promise<LocalMediaOutput> {
  return prepareLocalMediaOutput(outputPath, inputRealPath, getAllowedRoot, "m4a", directoryPolicy);
}
