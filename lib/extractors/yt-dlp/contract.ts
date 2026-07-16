import path from "node:path";

export const APPROVED_YT_DLP_VERSION = "2026.07.04";
export const APPROVED_YT_DLP_ARTIFACT_SHA256 = Object.freeze({
  portable: "495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd",
  linuxX64: "6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae"
});
export const YT_DLP_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
export const YT_DLP_STDERR_MAX_BYTES = 64 * 1024;
export const YT_DLP_METADATA_TIMEOUT_MS = 30_000;
export const YT_DLP_KILL_GRACE_MS = 2_000;

export type PlatformPageId =
  | "vimeo"
  | "reddit"
  | "youtube"
  | "tiktok"
  | "instagram"
  | "facebook"
  | "x";

export const YT_DLP_EXTRACTOR_KEYS: Readonly<Record<PlatformPageId, readonly string[]>> = Object.freeze({
  vimeo: Object.freeze(["Vimeo"]),
  reddit: Object.freeze(["Reddit"]),
  youtube: Object.freeze(["Youtube"]),
  tiktok: Object.freeze(["TikTok"]),
  instagram: Object.freeze(["Instagram"]),
  facebook: Object.freeze(["Facebook"]),
  x: Object.freeze(["Twitter"])
});

export function resolveYtDlpBinaryPath(
  value: string | undefined,
  nodeEnv: string | undefined
): string {
  const normalized = value?.trim() || "yt-dlp";
  if (!normalized || normalized.length > 1_024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError("YT_DLP_PATH is invalid.");
  }
  if (nodeEnv?.trim() === "production" && !path.isAbsolute(normalized)) {
    throw new TypeError("YT_DLP_PATH must be an absolute path in production.");
  }
  if (!path.isAbsolute(normalized) && normalized !== "yt-dlp") {
    throw new TypeError("YT_DLP_PATH must be the default basename or an absolute path.");
  }
  return normalized;
}

export function parseYtDlpVersionOutput(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(normalized)) {
    throw new TypeError("yt-dlp returned an invalid version response.");
  }
  if (normalized !== APPROVED_YT_DLP_VERSION) {
    throw new TypeError(`yt-dlp ${APPROVED_YT_DLP_VERSION} is required; found ${normalized}.`);
  }
  return normalized;
}
