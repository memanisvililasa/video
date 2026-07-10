import { AppError } from "@/lib/errors";
import type { StoredFile } from "@/lib/storage/types";
import { API_ERROR_CODES } from "@/lib/types";

export type FileRegistry = {
  registerFile: (file: StoredFile) => StoredFile;
  getRegisteredFile: (fileId: string) => StoredFile | null;
  deleteRegisteredFile: (fileId: string) => boolean;
  listRegisteredFiles: () => StoredFile[];
};

export function createFileRegistry(): FileRegistry {
  const files = new Map<string, StoredFile>();

  return Object.freeze({
    registerFile(file: StoredFile): StoredFile {
      if (files.has(file.id)) {
        throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Не удалось зарегистрировать подготовленный файл.");
      }
      const stored = Object.freeze({ ...file });
      files.set(file.id, stored);
      return stored;
    },
    getRegisteredFile(fileId: string): StoredFile | null {
      return files.get(fileId) ?? null;
    },
    deleteRegisteredFile(fileId: string): boolean {
      return files.delete(fileId);
    },
    listRegisteredFiles(): StoredFile[] {
      return [...files.values()];
    }
  });
}

type FileRegistryGlobal = typeof globalThis & {
  __videoSaveFileRegistryV1?: FileRegistry;
};

const registryGlobal = globalThis as FileRegistryGlobal;
const registry = registryGlobal.__videoSaveFileRegistryV1 ?? createFileRegistry();
registryGlobal.__videoSaveFileRegistryV1 = registry;

export const registerFile = registry.registerFile;
export const getRegisteredFile = registry.getRegisteredFile;
export const deleteRegisteredFile = registry.deleteRegisteredFile;
export const listRegisteredFiles = registry.listRegisteredFiles;
