import { isIP } from "node:net";
import { AppError } from "@/lib/errors";
import { validateOutboundHostname } from "@/lib/security/ssrf";
import { API_ERROR_CODES } from "@/lib/types";
import {
  canonicalizeTikTokVideoUrl,
  classifyTikTokUrl,
  isTikTokBoundaryHostname,
  type CanonicalTikTokVideoIdentity,
  type TikTokShortLinkIdentity
} from "@/lib/extractors/tiktok-url";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

export type TikTokResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

export type TikTokShortLinkHeadRequest = Readonly<{
  method: "HEAD";
  url: URL;
  address: TikTokResolvedAddress;
  timeoutMs: number;
  signal: AbortSignal;
}>;

export type TikTokShortLinkHeadResponse = Readonly<{
  statusCode: number;
  location?: string;
}>;

export type TikTokShortLinkResolverDependencies = Readonly<{
  resolveAddress: (hostname: string, timeoutMs: number, signal: AbortSignal) => Promise<TikTokResolvedAddress>;
  requestHead: (request: TikTokShortLinkHeadRequest) => Promise<TikTokShortLinkHeadResponse>;
}>;

export type TikTokShortLinkResolverOptions = Readonly<{
  timeoutMs?: number;
  maxRedirects?: number;
}>;

function extractorFailed(): AppError {
  return new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
}

function assertOptions(timeoutMs: number, maxRedirects: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("TikTok short-link timeout is outside the supported range.");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) {
    throw new TypeError("TikTok short-link redirect limit is outside the supported range.");
  }
}

function redirectTarget(current: URL, location: string | undefined): URL {
  if (!location) throw extractorFailed();
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw extractorFailed();
  }
  target.hash = "";
  const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    !isTikTokBoundaryHostname(hostname)
  ) {
    throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL);
  }
  return target;
}

function loopKey(url: URL): string {
  const classified = classifyTikTokUrl(url);
  return classified.sourceKind === "video-page"
    ? `video:${classified.videoId}`
    : `short:${classified.url.hostname}:${classified.shortCode}`;
}

function abortError(external: AbortSignal | undefined, timedOut: boolean): AppError {
  return external?.aborted
    ? new AppError(API_ERROR_CODES.JOB_CANCELLED)
    : timedOut
      ? new AppError(API_ERROR_CODES.EXTRACTOR_TIMEOUT)
      : extractorFailed();
}

async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  external: AbortSignal | undefined,
  timedOut: () => boolean
): Promise<T> {
  if (signal.aborted) throw abortError(external, timedOut());
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError(external, timedOut()));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function createTikTokShortLinkResolver(
  dependencies: TikTokShortLinkResolverDependencies,
  options: TikTokShortLinkResolverOptions = {}
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertOptions(timeoutMs, maxRedirects);

  return async (
    shortLink: TikTokShortLinkIdentity,
    request: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<CanonicalTikTokVideoIdentity> => {
    if (shortLink.sourceKind !== "short-link") throw new TypeError("A TikTok short-link identity is required.");
    if (request.signal?.aborted) throw new AppError(API_ERROR_CODES.JOB_CANCELLED);

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      let current = new URL(shortLink.url.toString());
      const visited = new Set<string>();

      for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
        const key = loopKey(current);
        if (visited.has(key)) throw extractorFailed();
        visited.add(key);

        const address = await awaitWithAbort(
          dependencies.resolveAddress(current.hostname, timeoutMs, controller.signal),
          controller.signal,
          request.signal,
          () => timedOut
        );
        const addressSafety = validateOutboundHostname(address.address);
        if (!addressSafety.ok || isIP(addressSafety.hostname) !== address.family) {
          throw new AppError(API_ERROR_CODES.PRIVATE_OR_LOCAL_URL);
        }

        const classified = classifyTikTokUrl(current);
        if (classified.sourceKind === "video-page") return canonicalizeTikTokVideoUrl(current);

        const response = await awaitWithAbort(dependencies.requestHead(Object.freeze({
          method: "HEAD",
          url: new URL(classified.url.toString()),
          address: Object.freeze({ address: addressSafety.hostname, family: address.family }),
          timeoutMs,
          signal: controller.signal
        })), controller.signal, request.signal, () => timedOut);
        if (controller.signal.aborted) throw abortError(request.signal, timedOut);
        if (response.statusCode === 404 || response.statusCode === 410) {
          throw new AppError(API_ERROR_CODES.CONTENT_UNAVAILABLE);
        }
        if (!REDIRECT_STATUS.has(response.statusCode)) throw extractorFailed();
        if (redirects === maxRedirects) throw extractorFailed();
        current = redirectTarget(current, response.location);
      }
      throw extractorFailed();
    } catch (error) {
      if (controller.signal.aborted) throw abortError(request.signal, timedOut);
      if (error instanceof AppError) throw error;
      throw extractorFailed();
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  };
}
