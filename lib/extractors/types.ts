import type { VideoMetadata } from "@/lib/types";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";

export type ExtractorContext = {
  signal?: AbortSignal;
  metadataTimeoutSeconds?: number;
  downloadTimeoutSeconds?: number;
  maxFileSizeBytes?: number;
  maxDurationSeconds?: number;
  onDownloadProgress?: (downloadedBytes: number, totalBytes?: number) => void;
};

export type DownloadContext = ExtractorContext & {
  workDir: string;
  processingPreset?: ProcessingPreset;
};

export type DownloadedSource = {
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export interface Extractor {
  id: string;
  name: string;
  supports(url: URL): boolean;
  extract(url: URL, context?: ExtractorContext): Promise<VideoMetadata>;
  download(url: URL, formatId: string, context: DownloadContext): Promise<DownloadedSource>;
}
