import "server-only";
import type { Readable } from "node:stream";
import type { MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import { isPublicMediaFileId, type MediaObjectStorage } from "@/lib/storage/media-storage";

export type DeliverableMediaFile = Readonly<{
  fileId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: string;
  stream: Readable;
  close: () => Promise<void>;
}>;

export interface MediaFileDelivery {
  get(fileId: string): Promise<DeliverableMediaFile | null>;
}

export function createDurableMediaFileDelivery(options: Readonly<{
  artifacts: MediaArtifactRepository;
  storage: MediaObjectStorage;
}>): MediaFileDelivery {
  return Object.freeze({
    async get(fileId: string): Promise<DeliverableMediaFile | null> {
      if (!isPublicMediaFileId(fileId)) return null;
      const artifact = await options.artifacts.getPublicFinal(fileId);
      if (!artifact || artifact.kind !== "final" || artifact.publicationState !== "published") return null;
      try {
        const opened = await options.storage.open(artifact.storageKey, artifact.sizeBytes);
        return Object.freeze({
          fileId: artifact.artifactId,
          filename: artifact.filename,
          contentType: artifact.contentType,
          sizeBytes: opened.sizeBytes,
          expiresAt: artifact.expiresAt,
          stream: opened.stream,
          close: opened.close
        });
      } catch {
        return null;
      }
    }
  });
}
