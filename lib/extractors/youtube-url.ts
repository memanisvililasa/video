import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const YOUTUBE_PAGE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be"
]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const STRIPPED_QUERY_KEYS = new Set(["si", "t", "start", "feature", "pp"]);
const PLAYLIST_QUERY_KEYS = new Set(["list", "index", "playlist"]);

export type CanonicalYouTubePage = Readonly<{
  videoId: string;
  url: URL;
  sourceKind: "watch" | "shorts" | "short-link";
}>;

function unsupported(): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    "Поддерживаются только публичные одиночные видео и Shorts YouTube.",
    400
  );
}

function playlistUnsupported(): AppError {
  return new AppError(API_ERROR_CODES.PLAYLIST_NOT_SUPPORTED);
}

export function isYouTubePageHostname(hostname: string): boolean {
  return YOUTUBE_PAGE_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
}

function assertQueryBoundary(url: URL, allowVideoId: boolean): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (PLAYLIST_QUERY_KEYS.has(normalized)) throw playlistUnsupported();
    if (seen.has(normalized)) throw unsupported();
    seen.add(normalized);
    if (allowVideoId && normalized === "v") continue;
    if (!STRIPPED_QUERY_KEYS.has(normalized)) throw unsupported();
  }
}

export function canonicalizeYouTubePageUrl(input: URL): CanonicalYouTubePage {
  const url = new URL(input.toString());
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    !YOUTUBE_PAGE_HOSTS.has(hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw unsupported();
  }

  let videoId: string | undefined;
  let sourceKind: CanonicalYouTubePage["sourceKind"];
  if (hostname === "youtu.be") {
    assertQueryBoundary(url, false);
    videoId = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    sourceKind = "short-link";
  } else if (url.pathname === "/watch" || url.pathname === "/watch/") {
    assertQueryBoundary(url, true);
    const values = url.searchParams.getAll("v");
    if (values.length !== 1) throw unsupported();
    videoId = values[0];
    sourceKind = "watch";
  } else {
    assertQueryBoundary(url, false);
    videoId = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    sourceKind = "shorts";
  }

  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) throw unsupported();
  return Object.freeze({
    videoId,
    sourceKind,
    url: new URL(`https://www.youtube.com/watch?v=${videoId}`)
  });
}

export function supportsYouTubePageUrl(url: URL): boolean {
  try {
    canonicalizeYouTubePageUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function canonicalizeYouTubeSourceInput(value: string, validatedUrl: URL): URL {
  let original: URL;
  try {
    original = new URL(value.trim());
  } catch {
    return validatedUrl;
  }
  return isYouTubePageHostname(original.hostname)
    ? canonicalizeYouTubePageUrl(original).url
    : validatedUrl;
}
