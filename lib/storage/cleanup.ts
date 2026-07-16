import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { deleteRegisteredFile, listRegisteredFiles } from "@/lib/storage/file-registry";
import { env } from "@/lib/config/env";
import { getStorageRoot } from "@/lib/storage/local-storage";
import { assertSafePath } from "@/lib/storage/path-safety";
import type { StoredFile } from "@/lib/storage/types";
import type { CleanupResult } from "@/lib/storage/types";

export type CleanupExpiredFilesOptions = {
  now?: number;
  protectedJobIds?: ReadonlySet<string>;
};

export type CleanupExpiredFilesDependencies = Readonly<{
  listRegisteredFiles: () => StoredFile[];
  deleteRegisteredFile: (fileId: string) => boolean;
  getStorageRoot: () => string;
  tempFileTtlMinutes: number;
}>;

const defaultDependencies: CleanupExpiredFilesDependencies = {
  listRegisteredFiles,
  deleteRegisteredFile,
  getStorageRoot,
  tempFileTtlMinutes: env.tempFileTtlMinutes
};

export async function cleanupExpiredFiles(
  options: CleanupExpiredFilesOptions = {},
  dependencies: CleanupExpiredFilesDependencies = defaultDependencies
): Promise<CleanupResult> {
  const now = options.now ?? Date.now();
  const storageRoot = path.resolve(dependencies.getStorageRoot());
  let removedFiles = 0;
  let removedDirectories = 0;
  let removedJobs = 0;

  for (const file of dependencies.listRegisteredFiles()) {
    if (options.protectedJobIds?.has(file.jobId)) continue;
    if (Date.parse(file.expiresAt) > now) continue;
    try {
      assertSafePath(storageRoot, path.resolve(file.path));
    } catch {
      continue;
    }
    await rm(file.path, { force: true }).catch(() => undefined);
    dependencies.deleteRegisteredFile(file.id);
    removedFiles += 1;
  }

  const jobsRoot = path.join(storageRoot, "jobs");
  const maxAgeMs = dependencies.tempFileTtlMinutes * 60 * 1000;

  try {
    const entries = await readdir(jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (options.protectedJobIds?.has(entry.name)) continue;

      const jobPath = path.join(jobsRoot, entry.name);
      const info = await lstat(jobPath).catch(() => null);
      if (!info || now - info.mtimeMs <= maxAgeMs) continue;

      await rm(jobPath, { recursive: true, force: true });
      removedDirectories += 1;
      removedJobs += 1;
    }
  } catch {
    // Storage may not exist yet in fresh local installs.
  }

  return {
    removedJobs,
    removedFiles,
    removedDirectories
  };
}
