import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const X_STATUS_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com"
]);
const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const X_POST_ID = /^[1-9][0-9]{0,19}$/;
const X_STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{0,19})\/?$/;
const TRACKING_QUERY_KEYS = new Set([
  "ref_src",
  "ref_url",
  "s",
  "t",
  "utm_campaign",
  "utm_medium",
  "utm_source"
]);

export type CanonicalXPostIdentity = Readonly<{
  platform: "x";
  postId: string;
  sourceKind: "status-post-candidate";
  canonicalUrl: URL;
}>;

function unsupported(): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    "Поддерживаются только однозначные ссылки-кандидаты на одиночную публикацию X/Twitter с видео.",
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
      rawKey !== key ||
      seen.has(key) ||
      !TRACKING_QUERY_KEYS.has(key) ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) throw unsupported();
    seen.add(key);
  }
}

function assertTransportBoundary(url: URL): void {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    /[%\\]/.test(url.pathname) ||
    !X_STATUS_HOSTS.has(hostname)
  ) throw unsupported();
}

export function canonicalizeXStatusUrl(input: URL): CanonicalXPostIdentity {
  const url = new URL(input.toString());
  url.hash = "";
  assertTransportBoundary(url);
  assertTrackingQuery(url);

  const match = X_STATUS_PATH.exec(url.pathname);
  const username = match?.[1];
  const postId = match?.[2];
  if (!username || !X_USERNAME.test(username) || !postId || !X_POST_ID.test(postId)) {
    throw unsupported();
  }

  return Object.freeze({
    platform: "x",
    postId,
    sourceKind: "status-post-candidate",
    canonicalUrl: new URL(`https://x.com/_/status/${postId}`)
  });
}

export function classifyXUrl(input: URL): CanonicalXPostIdentity {
  return canonicalizeXStatusUrl(input);
}

export function supportsInternalXUrl(url: URL): boolean {
  try {
    classifyXUrl(url);
    return true;
  } catch {
    return false;
  }
}
