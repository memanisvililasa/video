import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const REDDIT_POST_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"]);
const REDDIT_POST_ID = /^[a-z0-9]{5,12}$/;
const REDDIT_POST_PATH = /^\/r\/([A-Za-z0-9_]{1,32})\/comments\/([A-Za-z0-9]{5,12})(?:\/([A-Za-z0-9_-]{1,200}))?\/?$/;
const REDDIT_CANONICAL_POST_PATH = /^\/comments\/([A-Za-z0-9]{5,12})\/?$/;
const REDDIT_SHORT_PATH = /^\/([A-Za-z0-9]{5,12})\/?$/;
const TRACKING_QUERY_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_name",
  "utm_content",
  "utm_term",
  "share_id",
  "rdt",
  "ref"
]);

export type CanonicalRedditPost = Readonly<{
  postId: string;
  url: URL;
  sourceKind: "post" | "short-link";
}>;

function unsupported(): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    "Поддерживаются только публичные одиночные посты Reddit.",
    400
  );
}

export function isRedditPostHostname(hostname: string): boolean {
  return REDDIT_POST_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
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

export function canonicalizeRedditPostUrl(input: URL): CanonicalRedditPost {
  const url = new URL(input.toString());
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    !REDDIT_POST_HOSTS.has(hostname) ||
    url.username ||
    url.password ||
    url.port ||
    /[%\\]/.test(url.pathname)
  ) throw unsupported();

  assertTrackingQuery(url);
  const postId = (hostname === "redd.it"
    ? REDDIT_SHORT_PATH.exec(url.pathname)?.[1]
    : REDDIT_POST_PATH.exec(url.pathname)?.[2] ?? REDDIT_CANONICAL_POST_PATH.exec(url.pathname)?.[1]
  )?.toLowerCase();
  if (!postId || !REDDIT_POST_ID.test(postId)) throw unsupported();

  return Object.freeze({
    postId,
    sourceKind: hostname === "redd.it" ? "short-link" : "post",
    url: new URL(`https://www.reddit.com/comments/${postId}/`)
  });
}

export function supportsRedditPostUrl(url: URL): boolean {
  try {
    canonicalizeRedditPostUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function canonicalizeRedditSourceInput(value: string, validatedUrl: URL): URL {
  let original: URL;
  try {
    original = new URL(value.trim());
  } catch {
    return validatedUrl;
  }
  return isRedditPostHostname(original.hostname)
    ? canonicalizeRedditPostUrl(original).url
    : validatedUrl;
}
