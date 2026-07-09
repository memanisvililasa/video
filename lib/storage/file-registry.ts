import type { StoredFile } from "@/lib/storage/types";

const files = new Map<string, StoredFile>();

export function registerFile(file: StoredFile): StoredFile {
  files.set(file.id, file);
  return file;
}

export function getRegisteredFile(fileId: string): StoredFile | null {
  return files.get(fileId) ?? null;
}

export function deleteRegisteredFile(fileId: string): boolean {
  return files.delete(fileId);
}

export function listRegisteredFiles(): StoredFile[] {
  return [...files.values()];
}
