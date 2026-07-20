import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const FACEBOOK_CONTENT_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com"
]);
const FACEBOOK_SHORT_HOST = "fb.watch";
const FACEBOOK_CONTENT_ID = /^[1-9][0-9]{5,24}$/;
const FACEBOOK_PAGE_SLUG = /^[A-Za-z0-9._-]{1,100}$/;
const FACEBOOK_SHORT_CODE = /^[A-Za-z0-9_-]{4,64}$/;
const FACEBOOK_VIDEO_PATH = /^\/([A-Za-z0-9._-]{1,100})\/videos\/([1-9][0-9]{5,24})\/?$/;
const FACEBOOK_REEL_PATH = /^\/reel\/([1-9][0-9]{5,24})\/?$/;
const FACEBOOK_SHORT_PATH = /^\/([A-Za-z0-9_-]{4,64})\/?$/;
const TRACKING_QUERY_KEYS = new Set([
  "__cft__",
  "__tn__",
  "extid",
  "fbclid",
  "fref",
  "hc_ref",
  "locale",
  "mibextid",
  "rdid",
  "ref",
  "refsrc",
  "sfnsn",
  "share_url",
  "utm_campaign",
  "utm_medium",
  "utm_source"
]);

export type FacebookContentKind = "video" | "reel";

export type CanonicalFacebookContentIdentity = Readonly<{
  platform: "facebook";
  contentId: string;
  sourceKind: FacebookContentKind;
  canonicalUrl: URL;
}>;

export type FacebookShortLinkIdentity = Readonly<{
  platform: "facebook";
  shortCode: string;
  sourceKind: "short-link";
  url: URL;
}>;

export type FacebookUrlIdentity = CanonicalFacebookContentIdentity | FacebookShortLinkIdentity;

function unsupported(): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    "Поддерживаются только однозначные ссылки-кандидаты на одиночное Facebook video или Reel.",
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
    (!FACEBOOK_CONTENT_HOSTS.has(hostname) && hostname !== FACEBOOK_SHORT_HOST)
  ) throw unsupported();
  return hostname;
}

function pathSpecificError(url: URL): AppError | undefined {
  const pathname = url.pathname.toLowerCase();
  if (pathname === "/groups" || pathname.startsWith("/groups/")) {
    return new AppError(API_ERROR_CODES.GROUP_CONTENT_NOT_SUPPORTED);
  }
  if (pathname === "/stories" || pathname.startsWith("/stories/")) {
    return new AppError(API_ERROR_CODES.STORY_NOT_SUPPORTED);
  }
  if (pathname === "/live" || pathname.startsWith("/live/")) {
    return new AppError(API_ERROR_CODES.LIVE_NOT_SUPPORTED);
  }
  if (
    pathname === "/photo" ||
    pathname.startsWith("/photo/") ||
    pathname === "/photos" ||
    pathname.startsWith("/photos/")
  ) {
    return new AppError(API_ERROR_CODES.IMAGE_POST_NOT_SUPPORTED);
  }
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    return new AppError(API_ERROR_CODES.LOGIN_REQUIRED);
  }
  if (
    pathname === "/checkpoint" ||
    pathname.startsWith("/checkpoint/") ||
    pathname === "/challenge" ||
    pathname.startsWith("/challenge/")
  ) {
    return new AppError(API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE);
  }
  return undefined;
}

function trackingQuery(url: URL, allowVideoIdentity: boolean): string | undefined {
  const seen = new Set<string>();
  let count = 0;
  let trackingCount = 0;
  let videoId: string | undefined;
  for (const [rawKey, value] of url.searchParams) {
    count += 1;
    const key = rawKey.toLowerCase();
    if (
      count > 9 ||
      seen.has(key) ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) throw unsupported();
    seen.add(key);
    if (key === "v") {
      if (!allowVideoIdentity || rawKey !== "v" || !FACEBOOK_CONTENT_ID.test(value)) throw unsupported();
      videoId = value;
      continue;
    }
    trackingCount += 1;
    if (trackingCount > 8) throw unsupported();
    if (!TRACKING_QUERY_KEYS.has(key)) throw unsupported();
  }
  return videoId;
}

function canonicalContent(contentId: string, sourceKind: FacebookContentKind): CanonicalFacebookContentIdentity {
  return Object.freeze({
    platform: "facebook",
    contentId,
    sourceKind,
    canonicalUrl: new URL(sourceKind === "reel"
      ? `https://www.facebook.com/reel/${contentId}/`
      : `https://www.facebook.com/watch/?v=${contentId}`)
  });
}

export function canonicalizeFacebookContentUrl(input: URL): CanonicalFacebookContentIdentity {
  const classified = classifyFacebookUrl(input);
  if (classified.sourceKind === "short-link") throw unsupported();
  return classified;
}

export function classifyFacebookUrl(input: URL): FacebookUrlIdentity {
  const url = new URL(input.toString());
  url.hash = "";
  const hostname = assertTransportBoundary(url);

  if (hostname === FACEBOOK_SHORT_HOST) {
    trackingQuery(url, false);
    const match = FACEBOOK_SHORT_PATH.exec(url.pathname);
    const shortCode = match?.[1];
    if (!shortCode || !FACEBOOK_SHORT_CODE.test(shortCode)) throw unsupported();
    return Object.freeze({
      platform: "facebook",
      shortCode,
      sourceKind: "short-link",
      url: new URL(`https://${FACEBOOK_SHORT_HOST}/${shortCode}/`)
    });
  }

  const specificError = pathSpecificError(url);
  if (specificError) throw specificError;

  if (url.pathname === "/watch" || url.pathname === "/watch/") {
    const videoId = trackingQuery(url, true);
    if (!videoId) throw unsupported();
    return canonicalContent(videoId, "video");
  }

  trackingQuery(url, false);
  const reelId = FACEBOOK_REEL_PATH.exec(url.pathname)?.[1];
  if (reelId && FACEBOOK_CONTENT_ID.test(reelId)) return canonicalContent(reelId, "reel");

  const videoMatch = FACEBOOK_VIDEO_PATH.exec(url.pathname);
  const pageSlug = videoMatch?.[1];
  const videoId = videoMatch?.[2];
  if (!pageSlug || !videoId || !FACEBOOK_PAGE_SLUG.test(pageSlug) || !FACEBOOK_CONTENT_ID.test(videoId)) {
    throw unsupported();
  }
  return canonicalContent(videoId, "video");
}

export function isFacebookBoundaryHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return FACEBOOK_CONTENT_HOSTS.has(normalized) || normalized === FACEBOOK_SHORT_HOST;
}

export function supportsInternalFacebookUrl(url: URL): boolean {
  try {
    classifyFacebookUrl(url);
    return true;
  } catch {
    return false;
  }
}
