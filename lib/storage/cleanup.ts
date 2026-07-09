import type { CleanupResult } from "@/lib/storage/types";

export async function cleanupExpiredFiles(): Promise<CleanupResult> {
  return {
    removedFiles: 0,
    removedDirectories: 0
  };
}
