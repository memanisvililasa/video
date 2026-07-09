import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { deleteRegisteredFile, listRegisteredFiles } from "@/lib/storage/file-registry";
import { env } from "@/lib/config/env";
import { getStorageRoot } from "@/lib/storage/local-storage";
import type { CleanupResult } from "@/lib/storage/types";

export async function cleanupExpiredFiles(): Promise<CleanupResult> {
  const now = Date.now();
  let removedFiles = 0;
  let removedDirectories = 0;
  let removedJobs = 0;

  for (const file of listRegisteredFiles()) {
    if (Date.parse(file.expiresAt) > now) continue;
    await rm(file.path, { force: true }).catch(() => undefined);
    deleteRegisteredFile(file.id);
    removedFiles += 1;
  }

  const jobsRoot = path.join(getStorageRoot(), "jobs");
  const maxAgeMs = env.tempFileTtlMinutes * 60 * 1000;

  try {
    const entries = await readdir(jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const jobPath = path.join(jobsRoot, entry.name);
      const info = await stat(jobPath).catch(() => null);
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
