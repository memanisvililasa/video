import "server-only";
import { createHash } from "node:crypto";
import { AppError } from "@/lib/errors";
import {
  isTikTokMediaHostname,
  validateTikTokMediaLocator,
  type TikTokValidatedLocator
} from "@/lib/extractors/tiktok-media-policy";
import {
  parseTikTokHydrationMetadata,
  type TikTokSafeMetadata
} from "@/lib/extractors/tiktok-metadata";
import type { CanonicalTikTokVideoIdentity } from "@/lib/extractors/tiktok-url";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_SCRIPT_TAGS = 128;
const MAX_LOCATORS_PER_FORMAT = 8;
const MAX_FORMATS = 8;
const MAX_DIMENSION = 3_840;
const MAX_PIXELS = 8_294_400;
const MAX_FPS = 60;
const MAX_BITRATE = 50_000_000;
const MAX_FILESIZE = 500 * 1024 * 1024;
const HYDRATION_IDS = new Set(["__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"]);
const FORBIDDEN_VIDEO_KEY = /(?:dash|hls|m3u8|manifest|video[_-]?only|audio[_-]?only|adaptation|segment)/i;

export type TikTokAudioPresence = "present" | "absent" | "unknown";
export type TikTokCodecFamily = "h264" | "hevc";

export type TikTokInternalFormat = Readonly<{
  id: string;
  kind: "progressive";
  container: "mp4";
  codecFamily?: TikTokCodecFamily;
  width: number;
  height: number;
  fps?: number;
  approximateBitrate?: number;
  estimatedSizeBytes?: number;
  audioPresence: TikTokAudioPresence;
  compatibility: Readonly<{
    original: true;
    compatibleMp4: true;
    streamCopyCandidate: boolean;
  }>;
  staleMarker: "fresh";
}>;

export type TikTokServerLocatorReference = Readonly<{
  locator: URL;
  expiresAtEpochSeconds: number;
}>;

export type TikTokResolvedFormat = Readonly<{
  descriptor: TikTokInternalFormat;
  locatorReferences: readonly TikTokServerLocatorReference[];
}>;

export type TikTokResolvedMediaManifest = Readonly<{
  identity: CanonicalTikTokVideoIdentity;
  metadata: TikTokSafeMetadata;
  formats: readonly TikTokResolvedFormat[];
}>;

type LocatorGroup = Readonly<{
  sourceClass: "bitrate" | "play" | "download";
  rawLocators: readonly string[];
  urlKey?: string;
  dataSize?: number;
  bitrate?: number;
  fps?: number;
}>;

function failure(code: ApiErrorCode = API_ERROR_CODES.EXTRACTOR_FAILED): AppError {
  return new AppError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonDepth(value: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw failure();
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw failure();
    }
  }
  if (inString || depth !== 0) throw failure();
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "iu").exec(attributes);
  return match?.[1] ?? match?.[2];
}

function hydrationRoot(pageBody: Buffer): Readonly<{ id: string; root: Record<string, unknown> }> {
  if (pageBody.length < 1 || pageBody.length > MAX_PAGE_BYTES) throw failure();
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(pageBody);
  } catch {
    throw failure();
  }
  const lower = html.toLowerCase();
  const open = /<script\b([^>]*)>/giu;
  let scripts = 0;
  let found: Readonly<{ id: string; value: string }> | undefined;
  for (let match = open.exec(html); match; match = open.exec(html)) {
    scripts += 1;
    if (scripts > MAX_SCRIPT_TAGS) throw failure();
    const closing = lower.indexOf("</script>", open.lastIndex);
    if (closing < 0) throw failure();
    const id = attribute(match[1] ?? "", "id");
    if (id && HYDRATION_IDS.has(id)) {
      if (found || attribute(match[1] ?? "", "type")?.toLowerCase() !== "application/json") throw failure();
      const value = html.slice(open.lastIndex, closing).trim();
      if (!value || Buffer.byteLength(value, "utf8") > MAX_PAGE_BYTES) throw failure();
      found = Object.freeze({ id, value });
    }
    open.lastIndex = closing + "</script>".length;
  }
  if (!found) throw failure();
  assertJsonDepth(found.value);
  let root: unknown;
  try {
    root = JSON.parse(found.value) as unknown;
  } catch {
    throw failure();
  }
  if (!isRecord(root)) throw failure();
  return Object.freeze({ id: found.id, root });
}

function hydrationItem(
  hydration: Readonly<{ id: string; root: Record<string, unknown> }>,
  videoId: string
): Record<string, unknown> {
  if (hydration.id === "SIGI_STATE") {
    const module = hydration.root.ItemModule;
    if (!isRecord(module) || Object.keys(module).length !== 1 || !isRecord(module[videoId])) throw failure();
    return module[videoId];
  }
  const scope = hydration.root.__DEFAULT_SCOPE__;
  const detail = isRecord(scope) ? scope["webapp.video-detail"] : undefined;
  if (!isRecord(detail) || !isRecord(detail.itemInfo) || !isRecord(detail.itemInfo.itemStruct)) throw failure();
  return detail.itemInfo.itemStruct;
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum
    ? value as number
    : undefined;
}

function locatorStrings(value: unknown, depth = 0): readonly string[] {
  if (depth > 3) return Object.freeze([]);
  if (typeof value === "string") return Object.freeze([value]);
  if (Array.isArray(value)) {
    return Object.freeze(value.slice(0, MAX_LOCATORS_PER_FORMAT).flatMap((item) => locatorStrings(item, depth + 1)));
  }
  if (!isRecord(value)) return Object.freeze([]);
  const allowed = ["UrlList", "url_list", "src", "url", "download"];
  return Object.freeze(allowed.flatMap((key) => locatorStrings(value[key], depth + 1)));
}

function groups(video: Record<string, unknown>): readonly LocatorGroup[] {
  for (const [key, value] of Object.entries(video)) {
    if (FORBIDDEN_VIDEO_KEY.test(key) && value !== undefined && value !== null && value !== false) {
      throw failure(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
    }
  }
  const result: LocatorGroup[] = [];
  if (Array.isArray(video.bitrateInfo)) {
    for (const candidate of video.bitrateInfo.slice(0, 32)) {
      if (!isRecord(candidate) || !isRecord(candidate.PlayAddr)) continue;
      const rawLocators = locatorStrings(candidate.PlayAddr.UrlList);
      if (rawLocators.length === 0) continue;
      result.push(Object.freeze({
        sourceClass: "bitrate",
        rawLocators,
        ...(typeof candidate.PlayAddr.UrlKey === "string" && candidate.PlayAddr.UrlKey.length <= 512
          ? { urlKey: candidate.PlayAddr.UrlKey }
          : {}),
        ...(boundedInteger(candidate.PlayAddr.DataSize, MAX_FILESIZE) ? { dataSize: candidate.PlayAddr.DataSize as number } : {}),
        ...(boundedInteger(candidate.BitRate ?? candidate.Bitrate ?? candidate.bitrate, MAX_BITRATE)
          ? { bitrate: (candidate.BitRate ?? candidate.Bitrate ?? candidate.bitrate) as number }
          : {}),
        ...(boundedInteger(candidate.FPS ?? candidate.Fps ?? candidate.fps, MAX_FPS)
          ? { fps: (candidate.FPS ?? candidate.Fps ?? candidate.fps) as number }
          : {})
      }));
    }
  }
  for (const [sourceClass, value] of [["play", video.playAddr], ["download", video.downloadAddr]] as const) {
    const rawLocators = locatorStrings(value);
    if (rawLocators.length > 0) result.push(Object.freeze({ sourceClass, rawLocators }));
  }
  return Object.freeze(result);
}

function codecFamily(urlKey: string | undefined): TikTokCodecFamily | undefined {
  if (!urlKey) return undefined;
  if (/bytevc2|h266|vvc/i.test(urlKey)) throw failure(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
  if (/h265|hevc|bytevc1/i.test(urlKey)) return "hevc";
  return /h264|avc/i.test(urlKey) ? "h264" : undefined;
}

function dimensions(
  metadata: TikTokSafeMetadata,
  urlKey: string | undefined
): Readonly<{ width: number; height: number }> {
  let width = metadata.width;
  let height = metadata.height;
  const match = /(?:^|_)([0-9]{2,4})p(?:_|$)/i.exec(urlKey ?? "");
  if (match) {
    let dimension = Number(match[1]);
    if (dimension === 540) dimension = 576;
    const ratio = metadata.width / metadata.height;
    if (ratio < 1) {
      width = dimension;
      height = Math.floor(dimension / ratio / 2) * 2;
    } else {
      height = dimension;
      width = Math.ceil(dimension * ratio / 2) * 2;
    }
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) throw failure(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
  return Object.freeze({ width, height });
}

function parseLocator(value: string, nowMs: number): TikTokValidatedLocator | undefined {
  if (!value || value.length > 8_192) throw failure();
  let url: URL;
  try {
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    throw failure();
  }
  if (
    /\.(?:m3u8|mpd)(?:$|[?#])/i.test(url.pathname) ||
    /(?:mpegurl|dash\+xml)/i.test(url.searchParams.get("mime_type") ?? "")
  ) throw failure(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "www.tiktok.com") return undefined;
  if (!isTikTokMediaHostname(hostname)) throw failure(API_ERROR_CODES.DOWNLOAD_FAILED);
  return validateTikTokMediaLocator(url, nowMs);
}

function stableId(videoId: string, signature: Readonly<Record<string, unknown>>): string {
  return `ttf_${createHash("sha256")
    .update("tiktok-media-v1")
    .update("\0")
    .update(videoId)
    .update("\0")
    .update(JSON.stringify(signature))
    .digest("base64url")}`;
}

export function parseTikTokMediaManifest(
  identity: CanonicalTikTokVideoIdentity,
  pageBody: Buffer,
  options: Readonly<{ nowMs?: number; maxFileSizeBytes?: number }> = {}
): TikTokResolvedMediaManifest {
  const nowMs = options.nowMs ?? Date.now();
  const maxFileSizeBytes = options.maxFileSizeBytes ?? MAX_FILESIZE;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("TikTok manifest clock is invalid.");
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes < 1 || maxFileSizeBytes > MAX_FILESIZE) {
    throw new TypeError("TikTok manifest byte limit is invalid.");
  }
  const metadata = parseTikTokHydrationMetadata(identity, pageBody);
  const hydration = hydrationRoot(pageBody);
  const item = hydrationItem(hydration, identity.videoId);
  if (item.id !== identity.videoId || !isRecord(item.video)) throw failure();

  const audioPresence: TikTokAudioPresence = metadata.hasAudio === true
    ? "present"
    : metadata.hasAudio === false
      ? "absent"
      : "unknown";
  const resolved: TikTokResolvedFormat[] = [];
  for (const group of groups(item.video)) {
    const locatorReferences = group.rawLocators
      .map((value) => parseLocator(value, nowMs))
      .filter((value): value is TikTokValidatedLocator => value !== undefined)
      .map((value) => Object.freeze({ locator: value.url, expiresAtEpochSeconds: value.expiresAtEpochSeconds }));
    const uniqueLocators = [...new Map(locatorReferences.map((reference) => [reference.locator.toString(), reference])).values()]
      .sort((left, right) => left.locator.hostname.localeCompare(right.locator.hostname, "en"))
      .slice(0, MAX_LOCATORS_PER_FORMAT);
    if (uniqueLocators.length === 0) continue;
    const size = group.dataSize && group.dataSize <= maxFileSizeBytes ? group.dataSize : undefined;
    const codec = codecFamily(group.urlKey);
    const geometry = dimensions(metadata, group.urlKey);
    const signature = Object.freeze({
      version: 1,
      sourceClass: group.sourceClass,
      container: "mp4",
      codecFamily: codec ?? null,
      width: geometry.width,
      height: geometry.height,
      fps: group.fps ?? null,
      approximateBitrate: group.bitrate ?? null,
      estimatedSizeBytes: size ?? null,
      audioPresence
    });
    const descriptor: TikTokInternalFormat = Object.freeze({
      id: stableId(identity.videoId, signature),
      kind: "progressive",
      container: "mp4",
      ...(codec ? { codecFamily: codec } : {}),
      width: geometry.width,
      height: geometry.height,
      ...(group.fps ? { fps: group.fps } : {}),
      ...(group.bitrate ? { approximateBitrate: group.bitrate } : {}),
      ...(size ? { estimatedSizeBytes: size } : {}),
      audioPresence,
      compatibility: Object.freeze({
        original: true,
        compatibleMp4: true,
        streamCopyCandidate: codec === "h264"
      }),
      staleMarker: "fresh"
    });
    resolved.push(Object.freeze({ descriptor, locatorReferences: Object.freeze(uniqueLocators) }));
  }
  const selected = [...new Map(resolved.map((format) => [format.descriptor.id, format])).values()]
    .sort((left, right) =>
      right.descriptor.height - left.descriptor.height ||
      right.descriptor.width - left.descriptor.width ||
      (right.descriptor.approximateBitrate ?? 0) - (left.descriptor.approximateBitrate ?? 0) ||
      left.descriptor.id.localeCompare(right.descriptor.id, "en"))
    .slice(0, MAX_FORMATS);
  if (selected.length === 0) throw failure(API_ERROR_CODES.NO_SUPPORTED_FORMAT);
  return Object.freeze({ identity, metadata, formats: Object.freeze(selected) });
}
