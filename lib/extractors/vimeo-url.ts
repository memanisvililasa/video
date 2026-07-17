import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const VIMEO_PAGE_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const VIMEO_ID = /^[1-9]\d{0,19}$/;

export type CanonicalVimeoPage = Readonly<{
  videoId: string;
  url: URL;
}>;

function unsupported(): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    "Поддерживаются только публичные одиночные страницы Vimeo.",
    400
  );
}

export function isVimeoPageHostname(hostname: string): boolean {
  return VIMEO_PAGE_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ""));
}

export function canonicalizeVimeoPageUrl(input: URL): CanonicalVimeoPage {
  const url = new URL(input.toString());
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    !VIMEO_PAGE_HOSTS.has(hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw unsupported();
  }

  const match = hostname === "player.vimeo.com"
    ? /^\/video\/([1-9]\d{0,19})\/?$/.exec(url.pathname)
    : /^\/([1-9]\d{0,19})\/?$/.exec(url.pathname);
  const videoId = match?.[1];
  if (!videoId || !VIMEO_ID.test(videoId)) throw unsupported();

  return Object.freeze({
    videoId,
    url: new URL(`https://vimeo.com/${videoId}`)
  });
}

export function supportsVimeoPageUrl(url: URL): boolean {
  try {
    canonicalizeVimeoPageUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function canonicalizeVimeoSourceInput(value: string, validatedUrl: URL): URL {
  let original: URL;
  try {
    original = new URL(value.trim());
  } catch {
    return validatedUrl;
  }
  return isVimeoPageHostname(original.hostname)
    ? canonicalizeVimeoPageUrl(original).url
    : validatedUrl;
}
