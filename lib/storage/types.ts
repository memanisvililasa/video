export type StoredFile = {
  id: string;
  path: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  expiresAt: string;
};

export type CleanupResult = {
  removedFiles: number;
  removedDirectories: number;
};
