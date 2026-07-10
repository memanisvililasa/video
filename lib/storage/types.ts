export type StoredFile = {
  id: string;
  jobId: string;
  path: string;
  relativePath: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
  expiresAt: string;
  kind: "source" | "final";
};

export type CleanupResult = {
  removedJobs: number;
  removedFiles: number;
  removedDirectories: number;
};
