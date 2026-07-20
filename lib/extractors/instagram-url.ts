import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const INSTAGRAM_CONTENT_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,28}$/;
const INSTAGRAM_CONTENT_PATH = /^\/(reel|p)\/([A-Za-z0-9_-]{5,28})\/?$/;
const TRACKING_QUERY_KEYS = new Set([
  "hl",
  "ig_web_copy_link",
  "igsh",
  "igshid",
  "locale",
  "utm_campaign",
  "utm_medium",
  "utm_source"
]);

export type InstagramContentKind = "reel" | "video-post";

export type CanonicalInstagramContentIdentity = Readonly<{
  platform: "instagram";
  shortcode: string;
  sourceKind: InstagramContentKind;
  canonicalUrl: URL;
}>;

function unsupported(): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    "Поддерживаются только однозначные ссылки на Instagram Reel или публикацию-кандидат с одним видео.",
    400
  );
}

function assertTransportBoundary(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /[%\\]/.test(url.pathname) ||
    !INSTAGRAM_CONTENT_HOSTS.has(hostname)
  ) throw unsupported();
  return hostname;
}

function assertTrackingQuery(url: URL): void {
  const seen = new Set<string>();
  let count = 0;
  for (const [rawKey, value] of url.searchParams) {
    count += 1;
    const key = rawKey.toLowerCase();
    if (
      count > 8 ||
      seen.has(key) ||
      !TRACKING_QUERY_KEYS.has(key) ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) throw unsupported();
    seen.add(key);
  }
}

function pathSpecificError(url: URL): AppError | undefined {
  const pathname = url.pathname.toLowerCase();
  if (pathname === "/stories" || pathname.startsWith("/stories/")) {
    return new AppError(API_ERROR_CODES.STORY_NOT_SUPPORTED);
  }
  if (pathname === "/live" || pathname.startsWith("/live/")) {
    return new AppError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  }
  return undefined;
}

export function canonicalizeInstagramContentUrl(input: URL): CanonicalInstagramContentIdentity {
  const url = new URL(input.toString());
  url.hash = "";
  assertTransportBoundary(url);
  const specificError = pathSpecificError(url);
  if (specificError) throw specificError;
  assertTrackingQuery(url);

  const match = INSTAGRAM_CONTENT_PATH.exec(url.pathname);
  const route = match?.[1];
  const shortcode = match?.[2];
  if (!route || !shortcode || !INSTAGRAM_SHORTCODE.test(shortcode)) throw unsupported();

  const sourceKind: InstagramContentKind = route === "reel" ? "reel" : "video-post";
  return Object.freeze({
    platform: "instagram",
    shortcode,
    sourceKind,
    canonicalUrl: new URL(`https://www.instagram.com/${route}/${shortcode}/`)
  });
}

export function classifyInstagramUrl(input: URL): CanonicalInstagramContentIdentity {
  return canonicalizeInstagramContentUrl(input);
}

export function supportsInternalInstagramUrl(url: URL): boolean {
  try {
    classifyInstagramUrl(url);
    return true;
  } catch {
    return false;
  }
}
