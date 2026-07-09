import { env } from "@/lib/config/env";
import type { StoredFile } from "@/lib/storage/types";

export function getStorageRoot(): string {
  return env.storagePath;
}

export async function savePreparedFile(): Promise<StoredFile> {
  throw new Error("Local storage save is not implemented yet.");
}

export async function getPreparedFile(): Promise<StoredFile | null> {
  throw new Error("Local storage lookup is not implemented yet.");
}
