import { isIP } from "node:net";
import { AppError } from "@/lib/errors";
import {
  canonicalizeFacebookContentUrl,
  classifyFacebookUrl,
  isFacebookBoundaryHostname,
  type CanonicalFacebookContentIdentity,
  type FacebookShortLinkIdentity
} from "@/lib/extractors/facebook-url";
import { validateOutboundHostname } from "@/lib/security/ssrf";
import { API_ERROR_CODES } from "@/lib/types";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_HEADER_BYTES = 16 * 1024;

export type FacebookResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

export type FacebookShortLinkHeadRequest = Readonly<{
  method: "HEAD";
  url: URL;
  address: FacebookResolvedAddress;
  timeoutMs: number;
  signal: AbortSignal;
}>;

export type FacebookShortLinkHeadResponse = Readonly<{
  statusCode: number;
  headerBytes: number;
  location?: string;
}>;

export type FacebookShortLinkResolverDependencies = Readonly<{
  resolveAddress: (hostname: string, timeoutMs: number, signal: AbortSignal) => Promise<FacebookResolvedAddress>;
  requestHead: (request: FacebookShortLinkHeadRequest) => Promise<FacebookShortLinkHeadResponse>;
}>;

export type FacebookShortLinkResolverOptions = Readonly<{
  timeoutMs?: number;
  maxRedirects?: number;
}>;

function extractorFailed(): AppError {
  return new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
}

function assertOptions(timeoutMs: number, maxRedirects: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("Facebook short-link timeout is outside the supported range.");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) {
    throw new TypeError("Facebook short-link redirect limit is outside the supported range.");
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
  const hostnameSafety = validateOutboundHostname(hostname);
  if (!hostnameSafety.ok) {
    throw new AppError(hostnameSafety.code, hostnameSafety.message, 400);
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    !isFacebookBoundaryHostname(hostname)
  ) {
    throw new AppError(API_ERROR_CODES.UNSUPPORTED_URL);
  }
  return target;
}

function loopKey(url: URL): string {
  const classified = classifyFacebookUrl(url);
  return classified.sourceKind === "short-link"
    ? `short:${classified.shortCode}`
    : `${classified.sourceKind}:${classified.contentId}`;
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

export function createFacebookShortLinkResolver(
  dependencies: FacebookShortLinkResolverDependencies,
  options: FacebookShortLinkResolverOptions = {}
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  assertOptions(timeoutMs, maxRedirects);

  return async (
    shortLink: FacebookShortLinkIdentity,
    request: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<CanonicalFacebookContentIdentity> => {
    if (shortLink.sourceKind !== "short-link") throw new TypeError("A Facebook short-link identity is required.");
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

        const classified = classifyFacebookUrl(current);
        if (classified.sourceKind !== "short-link") return canonicalizeFacebookContentUrl(current);

        const response = await awaitWithAbort(dependencies.requestHead(Object.freeze({
          method: "HEAD",
          url: new URL(classified.url.toString()),
          address: Object.freeze({ address: addressSafety.hostname, family: address.family }),
          timeoutMs,
          signal: controller.signal
        })), controller.signal, request.signal, () => timedOut);
        if (controller.signal.aborted) throw abortError(request.signal, timedOut);
        if (!Number.isSafeInteger(response.headerBytes) || response.headerBytes < 0 || response.headerBytes > MAX_HEADER_BYTES) {
          throw extractorFailed();
        }
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
