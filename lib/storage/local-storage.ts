import { env } from "@/lib/config/env";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { getRegisteredFile, registerFile } from "@/lib/storage/file-registry";
import { normalizeStorageRoot, safeJoin } from "@/lib/storage/path-safety";
import type { StoredFile } from "@/lib/storage/types";

export function getStorageRoot(): string {
  return normalizeStorageRoot(env.storagePath);
}

export async function ensureJobDirectory(jobId: string): Promise<string> {
  const root = getStorageRoot();
  const jobsRoot = safeJoin(root, "jobs");
  const jobDirectory = safeJoin(jobsRoot, jobId);
  await mkdir(jobDirectory, { recursive: true });
  return jobDirectory;
}

export function getRelativeStoragePath(absolutePath: string): string {
  const root = getStorageRoot();
  return path.relative(root, absolutePath);
}

export async function savePreparedFile(
  file: Omit<StoredFile, "sizeBytes" | "kind"> & { sizeBytes?: number; kind?: StoredFile["kind"] }
): Promise<StoredFile> {
  const fileStats = await stat(file.path);
  const storedFile: StoredFile = {
    ...file,
    sizeBytes: file.sizeBytes ?? fileStats.size,
    kind: file.kind ?? "final"
  };

  return registerFile(storedFile);
}

export async function getPreparedFile(fileId: string): Promise<StoredFile | null> {
  const file = getRegisteredFile(fileId);
  if (!file || file.kind === "source") return null;

  if (Date.parse(file.expiresAt) <= Date.now()) {
    return null;
  }

  try {
    await stat(file.path);
    return file;
  } catch {
    return null;
  }
}
