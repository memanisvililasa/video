import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const TIKTOK_VIDEO_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
const TIKTOK_SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const TIKTOK_VIDEO_ID = /^[0-9]{15,24}$/;
const TIKTOK_USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const TIKTOK_SHORT_CODE = /^[A-Za-z0-9_]{4,64}$/;
const TIKTOK_VIDEO_PATH = /^\/@([A-Za-z0-9._-]{1,64})\/video\/([0-9]{15,24})\/?$/;
const TIKTOK_SHORT_PATH = /^\/([A-Za-z0-9_]{4,64})\/?$/;
const TIKTOK_WEB_SHORT_PATH = /^\/t\/([A-Za-z0-9_]{4,64})\/?$/;
const TRACKING_QUERY_KEYS = new Set([
  "_r",
  "_t",
  "is_copy_url",
  "is_from_webapp",
  "lang",
  "langcountry",
  "refer",
  "sender_device"
]);

export type CanonicalTikTokVideoIdentity = Readonly<{
  platform: "tiktok";
  videoId: string;
  canonicalUrl: URL;
  sourceKind: "video-page";
}>;

export type TikTokShortLinkIdentity = Readonly<{
  platform: "tiktok";
  shortCode: string;
  url: URL;
  sourceKind: "short-link";
}>;

export type TikTokUrlIdentity = CanonicalTikTokVideoIdentity | TikTokShortLinkIdentity;

function unsupported(): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    "Поддерживаются только однозначные ссылки на одиночные видео TikTok.",
    400
  );
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

function assertTransportBoundary(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /[%\\]/.test(url.pathname)
  ) throw unsupported();
  return hostname;
}

function pathSpecificError(url: URL): AppError | undefined {
  const pathname = url.pathname.toLowerCase();
  if (/^\/@[^/]+\/live\/?$/.test(pathname) || pathname === "/live" || pathname.startsWith("/live/")) {
    return new AppError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  }
  if (/^\/@[^/]+\/(?:photo|carousel)\//.test(pathname) || pathname.startsWith("/photo/")) {
    return new AppError(API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED);
  }
  return undefined;
}

export function isTikTokBoundaryHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return TIKTOK_VIDEO_HOSTS.has(normalized) || TIKTOK_SHORT_HOSTS.has(normalized);
}

export function isTikTokShortRedirectHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return TIKTOK_SHORT_HOSTS.has(normalized) || normalized === "www.tiktok.com";
}

export function canonicalizeTikTokVideoUrl(input: URL): CanonicalTikTokVideoIdentity {
  const url = new URL(input.toString());
  url.hash = "";
  const hostname = assertTransportBoundary(url);
  if (!TIKTOK_VIDEO_HOSTS.has(hostname)) throw unsupported();
  const specificError = pathSpecificError(url);
  if (specificError) throw specificError;
  assertTrackingQuery(url);

  const match = TIKTOK_VIDEO_PATH.exec(url.pathname);
  const username = match?.[1];
  const videoId = match?.[2];
  if (!username || !TIKTOK_USERNAME.test(username) || !videoId || !TIKTOK_VIDEO_ID.test(videoId)) {
    throw unsupported();
  }

  return Object.freeze({
    platform: "tiktok",
    videoId,
    canonicalUrl: new URL(`https://www.tiktok.com/@_/video/${videoId}`),
    sourceKind: "video-page"
  });
}

export function classifyTikTokUrl(input: URL): TikTokUrlIdentity {
  const url = new URL(input.toString());
  url.hash = "";
  const hostname = assertTransportBoundary(url);
  if (TIKTOK_VIDEO_HOSTS.has(hostname)) {
    if (hostname === "www.tiktok.com") {
      assertTrackingQuery(url);
      const shortCode = TIKTOK_WEB_SHORT_PATH.exec(url.pathname)?.[1];
      if (shortCode && TIKTOK_SHORT_CODE.test(shortCode)) {
        return Object.freeze({
          platform: "tiktok",
          shortCode,
          url: new URL(`https://www.tiktok.com/t/${shortCode}/`),
          sourceKind: "short-link"
        });
      }
    }
    return canonicalizeTikTokVideoUrl(url);
  }
  if (!TIKTOK_SHORT_HOSTS.has(hostname)) throw unsupported();
  assertTrackingQuery(url);

  const shortCode = TIKTOK_SHORT_PATH.exec(url.pathname)?.[1];
  if (!shortCode || !TIKTOK_SHORT_CODE.test(shortCode)) throw unsupported();
  return Object.freeze({
    platform: "tiktok",
    shortCode,
    url: new URL(`https://${hostname}/${shortCode}/`),
    sourceKind: "short-link"
  });
}

export function supportsInternalTikTokUrl(url: URL): boolean {
  try {
    classifyTikTokUrl(url);
    return true;
  } catch {
    return false;
  }
}
