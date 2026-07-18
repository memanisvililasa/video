import { createHash } from "node:crypto";
import type { RedditManifest, RedditManifestRepresentation } from "@/lib/extractors/reddit-manifest";
import type { ProcessingPreset } from "@/lib/ffmpeg/types";

const MAX_FORMATS = 6;
const MAX_DIMENSION = 3_840;
const MAX_PIXELS = 8_294_400;
const MAX_FPS = 60;
const MAX_VIDEO_BITRATE = 50_000_000;
const MAX_AUDIO_BITRATE = 512_000;
const ALL_PRESETS: readonly ProcessingPreset[] = Object.freeze([
  "original",
  "remux-to-mp4",
  "compatible-mp4",
  "audio-only"
]);
const SILENT_PRESETS: readonly ProcessingPreset[] = Object.freeze([
  "original",
  "remux-to-mp4",
  "compatible-mp4"
]);

export type RedditFormatTopology = "progressive" | "split" | "silent";

export type RedditFormatStrategy = Readonly<{
  stableId: string;
  platform: "reddit";
  mediaId: string;
  sourceClassification: "platform-page";
  topology: RedditFormatTopology;
  container: "mp4";
  videoCodec: string;
  audioCodec?: string;
  width: number;
  height: number;
  fps?: number;
  bitrate: number;
  durationSeconds: number;
  filesizeEstimateBytes: number;
  videoRepresentationIdentity: string;
  audioRepresentationIdentity?: string;
  mergeStrategy: "none" | "stream-copy-mp4";
  supportedPresets: readonly ProcessingPreset[];
  progressiveSource?: RedditManifestRepresentation;
  videoSource?: RedditManifestRepresentation;
  audioSource?: RedditManifestRepresentation;
}>;

function referenceSignature(reference: RedditManifestRepresentation): Readonly<Record<string, unknown>> {
  return Object.freeze({
    identity: reference.identity,
    kind: reference.kind,
    container: reference.container,
    videoCodec: reference.videoCodec ?? null,
    audioCodec: reference.audioCodec ?? null,
    width: reference.width ?? null,
    height: reference.height ?? null,
    fps: reference.fps ?? null,
    bitrate: reference.bitrate,
    durationSeconds: reference.durationSeconds
  });
}

function stableId(
  postId: string,
  mediaId: string,
  topology: RedditFormatTopology,
  video: RedditManifestRepresentation,
  audio?: RedditManifestRepresentation
): string {
  const signature = {
    postId,
    mediaId,
    topology,
    video: referenceSignature(video),
    audio: audio ? referenceSignature(audio) : null
  };
  const hash = createHash("sha256")
    .update("reddit")
    .update("\0")
    .update(JSON.stringify(signature))
    .digest("base64url");
  return `rf_${hash}`;
}

function safeVideo(reference: RedditManifestRepresentation, maximumBytes: number): boolean {
  const width = reference.width ?? 0;
  const height = reference.height ?? 0;
  return (reference.kind === "video" || reference.kind === "progressive") &&
    reference.container === "mp4" &&
    reference.videoCodec === "h264" &&
    width > 0 &&
    height > 0 &&
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION &&
    width * height <= MAX_PIXELS &&
    (reference.fps === undefined || reference.fps <= MAX_FPS) &&
    reference.bitrate > 0 &&
    reference.bitrate <= MAX_VIDEO_BITRATE &&
    reference.filesizeEstimateBytes > 0 &&
    reference.filesizeEstimateBytes <= maximumBytes;
}

function safeAudio(reference: RedditManifestRepresentation, maximumBytes: number): boolean {
  return reference.kind === "audio" &&
    reference.container === "mp4" &&
    reference.audioCodec === "aac" &&
    reference.bitrate > 0 &&
    reference.bitrate <= MAX_AUDIO_BITRATE &&
    reference.filesizeEstimateBytes > 0 &&
    reference.filesizeEstimateBytes <= maximumBytes;
}

function bestAudio(
  video: RedditManifestRepresentation,
  candidates: readonly RedditManifestRepresentation[],
  maximumBytes: number
): RedditManifestRepresentation | undefined {
  return candidates
    .filter((candidate) => safeAudio(candidate, maximumBytes) &&
      Math.abs(candidate.durationSeconds - video.durationSeconds) <= Math.max(0.25, video.durationSeconds * 0.01) &&
      candidate.filesizeEstimateBytes + video.filesizeEstimateBytes <= maximumBytes)
    .sort((left, right) => right.bitrate - left.bitrate || left.identity.localeCompare(right.identity, "en"))[0];
}

function qualityKey(strategy: RedditFormatStrategy): string {
  return `${strategy.width}x${strategy.height}:${Math.round(strategy.fps ?? 0)}`;
}

function compareSameQuality(left: RedditFormatStrategy, right: RedditFormatStrategy): number {
  const progressive = Number(right.topology === "progressive") - Number(left.topology === "progressive");
  if (progressive !== 0) return progressive;
  const withAudio = Number(Boolean(right.audioCodec)) - Number(Boolean(left.audioCodec));
  if (withAudio !== 0) return withAudio;
  const bitrate = right.bitrate - left.bitrate;
  if (bitrate !== 0) return bitrate;
  return left.stableId.localeCompare(right.stableId, "en");
}

function compareOutput(left: RedditFormatStrategy, right: RedditFormatStrategy): number {
  const height = right.height - left.height;
  if (height !== 0) return height;
  const width = right.width - left.width;
  if (width !== 0) return width;
  const fps = (right.fps ?? 0) - (left.fps ?? 0);
  if (fps !== 0) return fps;
  return compareSameQuality(left, right);
}

export function normalizeRedditFormats(input: Readonly<{
  postId: string;
  manifest: RedditManifest;
  hasAudio?: boolean;
  maxFileSizeBytes: number;
  maxDurationSeconds?: number;
}>): readonly RedditFormatStrategy[] {
  if (!/^[a-z0-9]{5,12}$/.test(input.postId)) throw new TypeError("Reddit post identity is invalid.");
  if (!/^[A-Za-z0-9]{5,64}$/.test(input.manifest.mediaId)) throw new TypeError("Reddit media identity is invalid.");
  if (!Number.isSafeInteger(input.maxFileSizeBytes) || input.maxFileSizeBytes <= 0) {
    throw new TypeError("Reddit maximum file size is invalid.");
  }
  if (
    input.maxDurationSeconds !== undefined &&
    (!Number.isFinite(input.maxDurationSeconds) || input.maxDurationSeconds <= 0)
  ) throw new TypeError("Reddit maximum duration is invalid.");
  if (input.maxDurationSeconds !== undefined && input.manifest.durationSeconds > input.maxDurationSeconds) return Object.freeze([]);

  const audio = input.manifest.representations.filter((candidate) => candidate.kind === "audio");
  const progressive = input.manifest.representations.filter((candidate) => candidate.kind === "progressive");
  if (input.hasAudio === false && (audio.length > 0 || progressive.length > 0)) return Object.freeze([]);
  const strategies: RedditFormatStrategy[] = [];
  for (const video of input.manifest.representations) {
    if (!safeVideo(video, input.maxFileSizeBytes)) continue;
    if (video.kind === "progressive") {
      if (video.audioCodec !== "aac") continue;
      strategies.push(Object.freeze({
        stableId: stableId(input.postId, input.manifest.mediaId, "progressive", video),
        platform: "reddit",
        mediaId: input.manifest.mediaId,
        sourceClassification: "platform-page",
        topology: "progressive",
        container: "mp4",
        videoCodec: video.videoCodec!,
        audioCodec: video.audioCodec,
        width: video.width!,
        height: video.height!,
        ...(video.fps ? { fps: video.fps } : {}),
        bitrate: video.bitrate,
        durationSeconds: video.durationSeconds,
        filesizeEstimateBytes: video.filesizeEstimateBytes,
        videoRepresentationIdentity: video.identity,
        mergeStrategy: "none",
        supportedPresets: ALL_PRESETS,
        progressiveSource: video
      }));
      continue;
    }
    const selectedAudio = bestAudio(video, audio, input.maxFileSizeBytes);
    if (selectedAudio) {
      strategies.push(Object.freeze({
        stableId: stableId(input.postId, input.manifest.mediaId, "split", video, selectedAudio),
        platform: "reddit",
        mediaId: input.manifest.mediaId,
        sourceClassification: "platform-page",
        topology: "split",
        container: "mp4",
        videoCodec: video.videoCodec!,
        audioCodec: selectedAudio.audioCodec,
        width: video.width!,
        height: video.height!,
        ...(video.fps ? { fps: video.fps } : {}),
        bitrate: video.bitrate + selectedAudio.bitrate,
        durationSeconds: Math.min(video.durationSeconds, selectedAudio.durationSeconds),
        filesizeEstimateBytes: video.filesizeEstimateBytes + selectedAudio.filesizeEstimateBytes,
        videoRepresentationIdentity: video.identity,
        audioRepresentationIdentity: selectedAudio.identity,
        mergeStrategy: "stream-copy-mp4",
        supportedPresets: ALL_PRESETS,
        videoSource: video,
        audioSource: selectedAudio
      }));
    } else if (input.hasAudio === false && audio.length === 0) {
      strategies.push(Object.freeze({
        stableId: stableId(input.postId, input.manifest.mediaId, "silent", video),
        platform: "reddit",
        mediaId: input.manifest.mediaId,
        sourceClassification: "platform-page",
        topology: "silent",
        container: "mp4",
        videoCodec: video.videoCodec!,
        width: video.width!,
        height: video.height!,
        ...(video.fps ? { fps: video.fps } : {}),
        bitrate: video.bitrate,
        durationSeconds: video.durationSeconds,
        filesizeEstimateBytes: video.filesizeEstimateBytes,
        videoRepresentationIdentity: video.identity,
        mergeStrategy: "none",
        supportedPresets: SILENT_PRESETS,
        videoSource: video
      }));
    }
  }

  const selected = new Map<string, RedditFormatStrategy>();
  for (const strategy of strategies) {
    const key = qualityKey(strategy);
    const current = selected.get(key);
    if (!current || compareSameQuality(strategy, current) < 0) selected.set(key, strategy);
  }
  return Object.freeze([...selected.values()].sort(compareOutput).slice(0, MAX_FORMATS));
}
