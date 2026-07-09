import type { VideoMetadata } from "@/lib/types";

export type DownloadContext = {
  workDir: string;
  signal?: AbortSignal;
};

export type DownloadedSource = {
  videoPath?: string;
  audioPath?: string;
  outputPath?: string;
  filename?: string;
};

export interface Extractor {
  id: string;
  name: string;
  supports(url: URL): boolean;
  extract(url: URL): Promise<VideoMetadata>;
  download(url: URL, formatId: string, context: DownloadContext): Promise<DownloadedSource>;
}
