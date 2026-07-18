import { createHash } from "node:crypto";
import type { PlatformPageId } from "@/lib/extractors/yt-dlp/contract";

export type DirectMediaReference = Readonly<{
  url: URL;
  formatId: string;
  container: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  filesizeBytes?: number;
  filesizeEstimateBytes?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  requestProfile?: "youtube-public-v1";
  dynamicRange?: "sdr" | "hdr" | "unknown";
  languagePreference?: number;
  audioChannels?: number;
  drc?: boolean;
}>;

export type PlatformFormatStrategy = Readonly<{
  stableId: string;
  platform: PlatformPageId;
  sourceClassification: "platform-page";
  container: "mp4" | "webm" | "mov";
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  filesizeBytes?: number;
  filesizeEstimateBytes?: number;
  hasVideo: true;
  hasAudio: boolean;
  qualityTier?: 360 | 480 | 720 | 1080;
  dynamicRange?: "sdr" | "hdr" | "unknown";
  transport: "progressive-direct" | "separate-direct";
  selectedDownloadStrategy: "single-file" | "download-and-stream-copy-merge";
  progressiveSource?: DirectMediaReference;
  videoSource?: DirectMediaReference;
  audioSource?: DirectMediaReference;
  audioOnlySource?: DirectMediaReference;
}>;

function stableId(platform: PlatformPageId, signature: Readonly<Record<string, unknown>>): string {
  const hash = createHash("sha256")
    .update(platform)
    .update("\0")
    .update(JSON.stringify(signature))
    .digest("base64url");
  return `pf_${hash}`;
}

function strategySize(reference: DirectMediaReference): number | undefined {
  return reference.filesizeBytes ?? reference.filesizeEstimateBytes;
}

function mergedContainer(video: DirectMediaReference, audio: DirectMediaReference): "mp4" | "webm" | null {
  if ((video.container === "mp4" || video.container === "mov") && (audio.container === "m4a" || audio.container === "mp4")) return "mp4";
  if (video.container === "webm" && audio.container === "webm") return "webm";
  return null;
}

function bestCompatibleAudio(
  video: DirectMediaReference,
  references: readonly DirectMediaReference[]
): DirectMediaReference | undefined {
  return references
    .filter((source) => !source.hasVideo && source.hasAudio && mergedContainer(video, source) !== null)
    .sort((left, right) => {
      const drc = Number(Boolean(left.drc)) - Number(Boolean(right.drc));
      if (drc !== 0) return drc;
      const language = (right.languagePreference ?? -1_000) - (left.languagePreference ?? -1_000);
      if (language !== 0) return language;
      const bitrate = (right.bitrate ?? 0) - (left.bitrate ?? 0);
      if (bitrate !== 0) return bitrate;
      return left.formatId.localeCompare(right.formatId, "en");
    })[0];
}

function signatureFor(reference: DirectMediaReference): Readonly<Record<string, unknown>> {
  return {
    formatId: reference.formatId,
    container: reference.container,
    videoCodec: reference.videoCodec ?? null,
    audioCodec: reference.audioCodec ?? null,
    width: reference.width ?? null,
    height: reference.height ?? null,
    fps: reference.fps ?? null,
    bitrate: reference.bitrate ?? null,
    hasVideo: reference.hasVideo,
    hasAudio: reference.hasAudio
  };
}

export function buildPlatformFormatStrategies(
  platform: PlatformPageId,
  references: readonly DirectMediaReference[],
  maximum = 12
): readonly PlatformFormatStrategy[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 12) throw new TypeError("Maximum format count is invalid.");
  const strategies: PlatformFormatStrategy[] = [];
  for (const source of references) {
    if (!source.hasVideo || (source.container !== "mp4" && source.container !== "webm" && source.container !== "mov")) continue;
    if (source.hasAudio) {
      const signature = { transport: "progressive-direct", source: signatureFor(source) };
      strategies.push(Object.freeze({
        stableId: stableId(platform, signature),
        platform,
        sourceClassification: "platform-page",
        container: source.container,
        videoCodec: source.videoCodec,
        audioCodec: source.audioCodec,
        width: source.width,
        height: source.height,
        fps: source.fps,
        bitrate: source.bitrate,
        filesizeBytes: source.filesizeBytes,
        filesizeEstimateBytes: source.filesizeEstimateBytes,
        hasVideo: true,
        hasAudio: true,
        dynamicRange: source.dynamicRange,
        transport: "progressive-direct",
        selectedDownloadStrategy: "single-file",
        progressiveSource: source,
        audioOnlySource: bestCompatibleAudio(source, references) ?? source
      }));
    }
  }

  for (const video of references.filter((source) => source.hasVideo && !source.hasAudio)) {
    const audio = bestCompatibleAudio(video, references);
    if (!audio) continue;
    const container = mergedContainer(video, audio);
    if (!container) continue;
    const exactVideo = video.filesizeBytes;
    const exactAudio = audio.filesizeBytes;
    const estimatedVideo = strategySize(video);
    const estimatedAudio = strategySize(audio);
    const signature = { transport: "separate-direct", video: signatureFor(video), audio: signatureFor(audio) };
    strategies.push(Object.freeze({
      stableId: stableId(platform, signature),
      platform,
      sourceClassification: "platform-page",
      container,
      videoCodec: video.videoCodec,
      audioCodec: audio.audioCodec,
      width: video.width,
      height: video.height,
      fps: video.fps,
      bitrate: (video.bitrate ?? 0) + (audio.bitrate ?? 0) || undefined,
      filesizeBytes: exactVideo !== undefined && exactAudio !== undefined ? exactVideo + exactAudio : undefined,
      filesizeEstimateBytes: estimatedVideo !== undefined && estimatedAudio !== undefined ? estimatedVideo + estimatedAudio : undefined,
      hasVideo: true,
      hasAudio: true,
      dynamicRange: video.dynamicRange,
      transport: "separate-direct",
      selectedDownloadStrategy: "download-and-stream-copy-merge",
      videoSource: video,
      audioSource: audio,
      audioOnlySource: audio
    }));
  }

  const deduplicated = new Map<string, PlatformFormatStrategy>();
  for (const strategy of strategies) deduplicated.set(strategy.stableId, strategy);
  return Object.freeze([...deduplicated.values()].sort((left, right) => {
    const height = (right.height ?? 0) - (left.height ?? 0);
    if (height !== 0) return height;
    const progressive = Number(right.transport === "progressive-direct") - Number(left.transport === "progressive-direct");
    if (progressive !== 0) return progressive;
    return left.stableId.localeCompare(right.stableId, "en");
  }).slice(0, maximum));
}
