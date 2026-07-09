import type { VideoMetadata } from "@/lib/types";

export type ExtractorContext = {
  signal?: AbortSignal;
  metadataTimeoutSeconds?: number;
  downloadTimeoutSeconds?: number;
  maxFileSizeBytes?: number;
};

export type DownloadContext = ExtractorContext & {
  workDir: string;
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
