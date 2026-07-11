import type { MediaJobApiResult } from "@/lib/api/media-job-dto";
import type { UserProcessingPreset } from "@/lib/client/media-preset-options";

const FILE_ID = /^file_[a-zA-Z0-9_-]{1,123}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/;
const SAFE_FILENAME = /^[^/\\\u0000-\u001f\u007f]{1,180}$/;

export type SafeResultSummary = Readonly<{
  filename: string;
  formatLabel: string;
  sizeLabel: string;
  downloadUrl: string;
  details: readonly string[];
}>;

export function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes < 1_024) return `${Math.round(sizeBytes)} Б`;

  const units = ["КБ", "МБ", "ГБ", "ТБ"] as const;
  let value = sizeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
  return `${rounded.replace(".", ",")} ${units[unitIndex]}`;
}

export function getCanonicalDownloadUrl(
  result: Pick<MediaJobApiResult, "fileId" | "downloadUrl">
): string | null {
  return FILE_ID.test(result.fileId) && result.downloadUrl === `/api/file/${result.fileId}`
    ? result.downloadUrl
    : null;
}

function formatDuration(seconds: number): string {
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const rest = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function outputFormat(result: MediaJobApiResult, preset: UserProcessingPreset): string {
  if (preset === "audio-only") return `M4A · ${result.mimeType}`;
  if (preset === "compatible-mp4") return `MP4 · ${result.mimeType}`;
  const extension = result.filename.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1]?.toUpperCase();
  return `${extension ?? "Исходный формат"} · ${result.mimeType}`;
}

export function getSafeResultSummary(
  result: MediaJobApiResult,
  preset: UserProcessingPreset
): SafeResultSummary | null {
  const downloadUrl = getCanonicalDownloadUrl(result);
  if (
    !downloadUrl ||
    result.processingPreset !== preset ||
    !SAFE_FILENAME.test(result.filename) ||
    !CONTENT_TYPE.test(result.mimeType) ||
    !Number.isSafeInteger(result.sizeBytes) ||
    result.sizeBytes <= 0 ||
    !Number.isFinite(result.media.durationSeconds) ||
    result.media.durationSeconds <= 0
  ) {
    return null;
  }

  const details = [`Длительность: ${formatDuration(result.media.durationSeconds)}`];
  if (preset !== "audio-only" && result.media.hasVideo) {
    if (result.media.width && result.media.height) {
      details.push(`Разрешение: ${result.media.width} × ${result.media.height}`);
    }
    if (result.media.videoCodec) details.push(`Видео: ${result.media.videoCodec.toUpperCase()}`);
  }
  if (result.media.hasAudio) {
    details.push(`Аудио: ${result.media.audioCodec?.toUpperCase() ?? "есть"}`);
  } else {
    details.push("Аудиодорожка: отсутствует");
  }

  return Object.freeze({
    filename: result.filename,
    formatLabel: outputFormat(result, preset),
    sizeLabel: formatFileSize(result.sizeBytes),
    downloadUrl,
    details: Object.freeze(details)
  });
}
