import { randomUUID } from "node:crypto";
import { env } from "@/lib/config/env";
import type { DownloadJob } from "@/lib/types";

function compactUuid(): string {
  return randomUUID().replace(/-/g, "");
}

export function createJobId(): string {
  return `job_${compactUuid()}`;
}

export function createFileId(): string {
  return `file_${compactUuid()}`;
}

export function getJobExpiresAt(now = Date.now()): string {
  return new Date(now + env.tempFileTtlMinutes * 60 * 1000).toISOString();
}

export function createReadyJob(jobId: string, fileId: string, createdAt: string, expiresAt: string): DownloadJob {
  return {
    id: jobId,
    status: "ready",
    createdAt,
    updatedAt: new Date().toISOString(),
    expiresAt,
    fileId,
    message: "Файл подготовлен."
  };
}
