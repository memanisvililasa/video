import { createHash } from "node:crypto";
import type { PlatformFormatStrategy } from "@/lib/extractors/yt-dlp/format-contract";
import type { ParsedPlatformMetadata } from "@/lib/extractors/yt-dlp/parser";

const QUALITY_TIERS = new Set([360, 480, 720, 1080]);
const MAX_DIMENSION = 3_840;
const MAX_PIXELS = 8_294_400;
const MAX_FPS = 120;
const MP4_VIDEO = /^(?:avc1|h264|av01|av1|vp9|vp09)(?:[._-]|$)/i;
const MP4_AUDIO = /^(?:mp4a|aac)(?:[._-]|$)/i;
const WEBM_VIDEO = /^(?:vp8|vp9|vp0[89]|av01|av1)(?:[._-]|$)/i;
const WEBM_AUDIO = /^(?:opus|vorbis)(?:[._-]|$)/i;

export type YouTubeQualityTier = 360 | 480 | 720 | 1080;

function referenceSignature(reference: NonNullable<PlatformFormatStrategy["progressiveSource"]>) {
  return {
    formatId: reference.formatId,
    container: reference.container,
    videoCodec: reference.videoCodec ?? null,
    audioCodec: reference.audioCodec ?? null,
    width: reference.width ?? null,
    height: reference.height ?? null,
    fps: reference.fps ?? null,
    hasVideo: reference.hasVideo,
    hasAudio: reference.hasAudio,
    requestProfile: reference.requestProfile ?? null,
    dynamicRange: reference.dynamicRange ?? "unknown"
  };
}

function youtubeStableId(strategy: PlatformFormatStrategy): string {
  const signature = strategy.transport === "progressive-direct"
    ? {
        transport: strategy.transport,
        source: referenceSignature(strategy.progressiveSource!),
        audioOnly: referenceSignature(strategy.audioOnlySource!)
      }
    : {
        transport: strategy.transport,
        video: referenceSignature(strategy.videoSource!),
        audio: referenceSignature(strategy.audioSource!),
        audioOnly: referenceSignature(strategy.audioOnlySource!)
      };
  const hash = createHash("sha256")
    .update("youtube")
    .update("\0")
    .update(JSON.stringify(signature))
    .digest("base64url");
  return `pf_${hash}`;
}

function strategySize(strategy: PlatformFormatStrategy): number | undefined {
  return strategy.filesizeBytes ?? strategy.filesizeEstimateBytes;
}

function hasAllowedCodecs(strategy: PlatformFormatStrategy): boolean {
  const video = strategy.videoCodec;
  const audio = strategy.audioCodec;
  if (!video || !audio) return false;
  if (strategy.container === "mp4") return MP4_VIDEO.test(video) && MP4_AUDIO.test(audio);
  if (strategy.container === "webm") return WEBM_VIDEO.test(video) && WEBM_AUDIO.test(audio);
  return false;
}

function hasSafeSources(strategy: PlatformFormatStrategy): boolean {
  const sources = strategy.transport === "progressive-direct"
    ? [strategy.progressiveSource, strategy.audioOnlySource]
    : [strategy.videoSource, strategy.audioSource, strategy.audioOnlySource];
  return sources.every((source) => Boolean(source && source.requestProfile === "youtube-public-v1"));
}

function qualityTier(strategy: PlatformFormatStrategy): YouTubeQualityTier | null {
  const width = strategy.width;
  const height = strategy.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height) return null;
  const tier = Math.min(width, height);
  return QUALITY_TIERS.has(tier) ? tier as YouTubeQualityTier : null;
}

function compareCandidates(left: PlatformFormatStrategy, right: PlatformFormatStrategy): number {
  const leftFpsClass = (left.fps ?? 0) > 30 ? 1 : 0;
  const rightFpsClass = (right.fps ?? 0) > 30 ? 1 : 0;
  if (leftFpsClass !== rightFpsClass) return rightFpsClass - leftFpsClass;
  const progressive = Number(right.transport === "progressive-direct") - Number(left.transport === "progressive-direct");
  if (progressive !== 0) return progressive;
  const mp4 = Number(right.container === "mp4") - Number(left.container === "mp4");
  if (mp4 !== 0) return mp4;
  const fps = (right.fps ?? 0) - (left.fps ?? 0);
  if (fps !== 0) return fps;
  const bitrate = (right.bitrate ?? 0) - (left.bitrate ?? 0);
  if (bitrate !== 0) return bitrate;
  return left.stableId.localeCompare(right.stableId, "en");
}

export function selectYouTubeFormats(
  metadata: ParsedPlatformMetadata,
  maxFileSizeBytes: number
): readonly PlatformFormatStrategy[] {
  if (!Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    throw new TypeError("YouTube maximum file size is invalid.");
  }
  const candidates: PlatformFormatStrategy[] = [];
  for (const strategy of metadata.strategies) {
    const tier = qualityTier(strategy);
    const size = strategySize(strategy);
    const width = strategy.width ?? 0;
    const height = strategy.height ?? 0;
    if (
      strategy.platform !== "youtube" ||
      !tier ||
      !strategy.hasAudio ||
      !strategy.audioOnlySource ||
      !hasAllowedCodecs(strategy) ||
      !hasSafeSources(strategy) ||
      strategy.dynamicRange === "hdr" ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      width * height > MAX_PIXELS ||
      (strategy.fps !== undefined && (!Number.isFinite(strategy.fps) || strategy.fps <= 0 || strategy.fps > MAX_FPS)) ||
      !Number.isSafeInteger(size) ||
      (size as number) <= 0 ||
      (size as number) > maxFileSizeBytes
    ) continue;
    candidates.push(Object.freeze({
      ...strategy,
      stableId: youtubeStableId(strategy),
      qualityTier: tier,
      dynamicRange: strategy.dynamicRange ?? "unknown"
    }));
  }

  const selected = new Map<YouTubeQualityTier, PlatformFormatStrategy>();
  for (const tier of [360, 480, 720, 1080] as const) {
    const best = candidates.filter((candidate) => candidate.qualityTier === tier).sort(compareCandidates)[0];
    if (best) selected.set(tier, best);
  }
  return Object.freeze([...selected.values()].sort((left, right) =>
    (right.qualityTier ?? 0) - (left.qualityTier ?? 0)
  ));
}
