import { describe, expect, it } from "vitest";
import { normalizeRedditFormats } from "@/lib/extractors/reddit-formats";
import type { RedditManifest, RedditManifestRepresentation } from "@/lib/extractors/reddit-manifest";

const MEDIA_ID = "media42";
const MAX_BYTES = 50 * 1024 * 1024;

function representation(
  identity: string,
  kind: RedditManifestRepresentation["kind"],
  overrides: Partial<RedditManifestRepresentation> = {}
): RedditManifestRepresentation {
  const video = kind !== "audio";
  const audio = kind !== "video";
  const bitrate = kind === "audio" ? 128_000 : 2_000_000;
  return {
    identity,
    url: new URL(`https://v.redd.it/${MEDIA_ID}/${identity}.mp4?signature=synthetic`),
    kind,
    container: "mp4",
    ...(video ? { videoCodec: "h264", width: 1280, height: 720, fps: 30 } : {}),
    ...(audio ? { audioCodec: "aac" } : {}),
    bitrate,
    durationSeconds: 12,
    filesizeEstimateBytes: Math.ceil(bitrate * 12 / 8),
    ...overrides
  };
}

function manifest(representations: readonly RedditManifestRepresentation[]): RedditManifest {
  return { mediaId: MEDIA_ID, durationSeconds: 12, representations };
}

function formats(representations: readonly RedditManifestRepresentation[], hasAudio: boolean | undefined = true) {
  return normalizeRedditFormats({
    postId: "abc123",
    manifest: manifest(representations),
    hasAudio,
    maxFileSizeBytes: MAX_BYTES,
    maxDurationSeconds: 60
  });
}

describe("Reddit format normalization", () => {
  it("builds stable opaque split IDs without URLs, queries, headers, or paths", () => {
    const first = formats([representation("video-720", "video"), representation("audio-128", "audio")]);
    const refreshed = formats([
      representation("video-720", "video", { url: new URL(`https://v.redd.it/${MEDIA_ID}/video-720.mp4?signature=fresh`) }),
      representation("audio-128", "audio", { url: new URL(`https://v.redd.it/${MEDIA_ID}/audio-128.mp4?signature=fresh`) })
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      topology: "split",
      mergeStrategy: "stream-copy-mp4",
      videoRepresentationIdentity: "video-720",
      audioRepresentationIdentity: "audio-128",
      supportedPresets: ["original", "remux-to-mp4", "compatible-mp4", "audio-only"]
    });
    expect(first[0].stableId).toBe(refreshed[0].stableId);
    expect(first[0].stableId).toMatch(/^rf_[A-Za-z0-9_-]{43}$/);
    expect(first[0].stableId).not.toMatch(/https|v\.redd|signature|video-720|audio-128/i);
  });

  it("prefers progressive over split at an equivalent quality and sorts deterministically", () => {
    const selected = formats([
      representation("video-360", "video", { width: 640, height: 360, bitrate: 800_000, filesizeEstimateBytes: 1_200_000 }),
      representation("video-720", "video"),
      representation("audio-128", "audio"),
      representation("progressive-720", "progressive", { bitrate: 2_200_000, filesizeEstimateBytes: 3_300_000 })
    ]);
    expect(selected.map((item) => [item.height, item.topology])).toEqual([
      [720, "progressive"],
      [360, "split"]
    ]);
  });

  it("models a proven silent source without creating a fictitious audio representation", () => {
    const selected = formats([representation("video-720", "video")], false);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      topology: "silent",
      mergeStrategy: "none",
      supportedPresets: ["original", "remux-to-mp4", "compatible-mp4"]
    });
    expect(selected[0].audioCodec).toBeUndefined();
    expect(selected[0].audioRepresentationIdentity).toBeUndefined();
    expect(selected[0].audioSource).toBeUndefined();
  });

  it("fails closed when audio truth and manifest topology disagree", () => {
    expect(formats([representation("video-720", "video")], true)).toEqual([]);
    expect(formats([representation("video-720", "video")], undefined)).toEqual([]);
    expect(formats([
      representation("video-720", "video"),
      representation("audio-128", "audio")
    ], false)).toEqual([]);
  });

  it("deduplicates equivalent qualities and computes a combined bounded estimate", () => {
    const video = representation("video-720-a", "video", { bitrate: 2_000_000, filesizeEstimateBytes: 3_000_000 });
    const duplicate = representation("video-720-b", "video", { bitrate: 1_500_000, filesizeEstimateBytes: 2_250_000 });
    const audio = representation("audio-128", "audio", { filesizeEstimateBytes: 192_000 });
    const selected = formats([duplicate, video, audio]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      videoRepresentationIdentity: "video-720-a",
      filesizeEstimateBytes: 3_192_000
    });
  });

  it("filters excessive resolution, FPS, bitrate, duration, filesize and unsupported codec", () => {
    expect(formats([
      representation("too-wide", "video", { width: 5000 }),
      representation("too-fast", "video", { fps: 120 }),
      representation("too-large", "video", { filesizeEstimateBytes: MAX_BYTES + 1 }),
      representation("bad-codec", "video", { videoCodec: "unknown" }),
      representation("audio", "audio")
    ])).toEqual([]);
    expect(normalizeRedditFormats({
      postId: "abc123",
      manifest: { ...manifest([representation("video", "video"), representation("audio", "audio")]), durationSeconds: 120 },
      hasAudio: true,
      maxFileSizeBytes: MAX_BYTES,
      maxDurationSeconds: 60
    })).toEqual([]);
  });

  it("changes the opaque ID when post or media identity changes", () => {
    const references = [representation("video", "video"), representation("audio", "audio")];
    const initial = formats(references)[0].stableId;
    const changedPost = normalizeRedditFormats({
      postId: "other42",
      manifest: manifest(references),
      hasAudio: true,
      maxFileSizeBytes: MAX_BYTES
    })[0].stableId;
    const changedMedia = normalizeRedditFormats({
      postId: "abc123",
      manifest: { ...manifest(references), mediaId: "fresh42" },
      hasAudio: true,
      maxFileSizeBytes: MAX_BYTES
    })[0].stableId;
    expect(new Set([initial, changedPost, changedMedia]).size).toBe(3);
  });
});
