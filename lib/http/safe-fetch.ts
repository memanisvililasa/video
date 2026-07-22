import { createWriteStream } from "node:fs";
import { link, rm, unlink } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";
import { AppError } from "@/lib/errors";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";
import { validateOutboundHostname, validateRedirectHostname } from "@/lib/security/ssrf";
import {
  YOUTUBE_PUBLIC_ACCEPT,
  YOUTUBE_PUBLIC_ACCEPT_LANGUAGE,
  YOUTUBE_PUBLIC_SEC_FETCH_MODE,
  YOUTUBE_PUBLIC_USER_AGENT
} from "@/lib/extractors/yt-dlp/contract";

const DEFAULT_METADATA_TIMEOUT_SECONDS = 10;
const DEFAULT_DOWNLOAD_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;
const MAX_IN_MEMORY_BODY_BYTES = 8 * 1024 * 1024;
const USER_AGENT = "VideoSave-SafeFetcher/1.0";
const REDDIT_PUBLIC_USER_AGENT = "VideoSave/1.0 (personal-use Reddit metadata)";
const REDDIT_MEDIA_USER_AGENT = "VideoSave/1.0 (personal-use Reddit media)";
const REDDIT_PUBLIC_ACCEPT = "application/json";
const REDDIT_MEDIA_ACCEPT = "application/dash+xml,video/mp4,audio/mp4,application/octet-stream";
export const TIKTOK_PUBLIC_PAGE_USER_AGENT = "VideoSave/1.0 (restricted TikTok public metadata)";
export const TIKTOK_PUBLIC_PAGE_ACCEPT = "text/html,application/xhtml+xml";
export const TIKTOK_MEDIA_USER_AGENT = "VideoSave/1.0 (restricted TikTok media)";
export const TIKTOK_MEDIA_ACCEPT = "video/mp4,application/mp4,application/octet-stream";
export const TIKTOK_MEDIA_REFERER = "https://www.tiktok.com/";

export type SafeHeaders = Record<string, string>;

export type SafeFetchOptions = {
  timeoutSeconds?: number;
  maxRedirects?: number;
  requireHttps?: boolean;
  requestProfile?: "default" | "youtube-public-v1" | "reddit-public-v1" | "reddit-media-v1" | "tiktok-public-page-v1" | "tiktok-media-v1";
  allowHostname?: (hostname: string) => boolean;
  signal?: AbortSignal;
  /** @internal Safe, in-memory evidence for an owner-authorized diagnostic run. */
  diagnosticObserver?: SafeDownloadDiagnosticObserver;
};

export type SafeResponseMetadata = {
  finalUrl: URL;
  statusCode: number;
  headers: SafeHeaders;
  contentType?: string;
  contentLength?: number;
};

export type SafeDownloadOptions = SafeFetchOptions & {
  maxBytes: number;
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
};

export type SafeDownloadResult = SafeResponseMetadata & {
  sizeBytes: number;
};

export type SafeBodyFetchOptions = SafeFetchOptions & {
  maxBytes: number;
};

export type SafeBodyFetchResult = SafeResponseMetadata & {
  body: Buffer;
  sizeBytes: number;
};

type RequestMethod = "HEAD" | "GET";
type ResolvedSafeFetchOptions = Omit<Required<SafeFetchOptions>, "diagnosticObserver"> & {
  diagnosticObserver?: SafeDownloadDiagnosticObserver;
};

export type SafeDownloadStreamResult = SafeResponseMetadata & {
  stream?: http.IncomingMessage;
};

type RequestResult = SafeDownloadStreamResult;

export type SafeFileDownloaderDependencies = {
  requestDownload: (url: URL, options: SafeFetchOptions) => Promise<SafeDownloadStreamResult>;
  linkFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
  unlinkFile?: (filePath: string) => Promise<void>;
  removeFile?: (filePath: string) => Promise<void>;
};

export type SafeBodyFetcherDependencies = {
  requestBody: (url: URL, options: SafeFetchOptions) => Promise<SafeDownloadStreamResult>;
};

type RequestLookupOptions = {
  all?: boolean;
};

type RequestLookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: 4 | 6 }>, family?: 4 | 6) => void;
type SafeLookupAddress = Readonly<{ address: string; family: number }>;
type SafeAddressLookup = (hostname: string) => Promise<readonly SafeLookupAddress[]>;

export type SafeDownloadDiagnosticPhase =
  | "locator-validation-started"
  | "locator-validated"
  | "expiry-validated"
  | "request-profile-built"
  | "dns-ip-validation-completed"
  | "media-request-started"
  | "redirect-evaluated"
  | "response-received"
  | "http-status-classified"
  | "content-type-classified"
  | "body-streaming-started"
  | "byte-budget-evaluated"
  | "body-streaming-completed"
  | "temporary-file-finalized"
  | "media-container-validation-started"
  | "media-container-validation-completed"
  | "cleanup-completed"
  | "failed";

export type SafeDownloadDiagnosticHostname =
  | "v16-webapp-prime.tiktok.com"
  | "v19-webapp-prime.tiktok.com"
  | "unapproved"
  | "none";
export type SafeDownloadDiagnosticScheme = "https" | "http" | "other" | "unknown";
export type SafeDownloadDiagnosticPort = 443 | 80 | "custom" | "unknown";
export type SafeDownloadDiagnosticStatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "no-response" | "unknown";
export type SafeDownloadDiagnosticContentCategory = "video" | "binary" | "html" | "json" | "text" | "empty" | "missing" | "unknown";
export type SafeDownloadDiagnosticBytesCategory = "zero" | "small" | "within-budget" | "at-limit" | "over-limit" | "unknown";
export type SafeDownloadDiagnosticTermination =
  | "success"
  | "timeout"
  | "cancelled"
  | "network"
  | "redirect-rejected"
  | "response-rejected"
  | "byte-limit"
  | "filesystem"
  | "validation"
  | "cleanup"
  | "unknown";
export type SafeDownloadDiagnosticCleanup = "not-required" | "success" | "failure" | "unknown";

export type SafeDownloadDiagnosticEvent = Readonly<{
  phase: SafeDownloadDiagnosticPhase;
  requestCount: number;
  approvedHostname: SafeDownloadDiagnosticHostname;
  scheme: SafeDownloadDiagnosticScheme;
  effectivePort: SafeDownloadDiagnosticPort;
  redirectCount: number;
  statusClass: SafeDownloadDiagnosticStatusClass;
  contentCategory: SafeDownloadDiagnosticContentCategory;
  contentLengthPresent: "yes" | "no" | "unknown";
  boundedBytesCategory: SafeDownloadDiagnosticBytesCategory;
  terminationCategory: SafeDownloadDiagnosticTermination;
  cleanupResult: SafeDownloadDiagnosticCleanup;
  safeErrorCode: ApiErrorCode | "none";
}>;

const SAFE_DOWNLOAD_DIAGNOSTIC_BRAND: unique symbol = Symbol("safe-download-diagnostic");

export type SafeDownloadDiagnosticObserver = Readonly<{
  snapshot(): readonly SafeDownloadDiagnosticEvent[];
  readonly [SAFE_DOWNLOAD_DIAGNOSTIC_BRAND]: true;
}>;

export type SafeDownloadDiagnosticUpdate = Readonly<{
  phase: SafeDownloadDiagnosticPhase;
  requestCount?: number;
  approvedHostname?: SafeDownloadDiagnosticHostname;
  scheme?: SafeDownloadDiagnosticScheme;
  effectivePort?: SafeDownloadDiagnosticPort;
  redirectCount?: number;
  statusClass?: SafeDownloadDiagnosticStatusClass;
  contentCategory?: SafeDownloadDiagnosticContentCategory;
  contentLengthPresent?: "yes" | "no" | "unknown";
  boundedBytesCategory?: SafeDownloadDiagnosticBytesCategory;
  terminationCategory?: SafeDownloadDiagnosticTermination;
  cleanupResult?: SafeDownloadDiagnosticCleanup;
  safeErrorCode?: ApiErrorCode | "none";
}>;

type SafeDownloadDiagnosticStore = {
  events: SafeDownloadDiagnosticEvent[];
};

const SAFE_DOWNLOAD_DIAGNOSTIC_STORES = new WeakMap<object, SafeDownloadDiagnosticStore>();

function lastSafeDownloadDiagnosticEvent(
  observer: SafeDownloadDiagnosticObserver | undefined
): SafeDownloadDiagnosticEvent | undefined {
  return observer ? SAFE_DOWNLOAD_DIAGNOSTIC_STORES.get(observer)?.events.at(-1) : undefined;
}

function isSafeDownloadDiagnosticObserver(
  observer: SafeDownloadDiagnosticObserver | undefined
): boolean {
  return observer ? SAFE_DOWNLOAD_DIAGNOSTIC_STORES.has(observer) : false;
}

function hasSafeDownloadDiagnosticPhase(
  observer: SafeDownloadDiagnosticObserver | undefined,
  phase: SafeDownloadDiagnosticPhase,
  requestCount: number
): boolean {
  return observer
    ? SAFE_DOWNLOAD_DIAGNOSTIC_STORES.get(observer)?.events.some(
      (event) => event.phase === phase && event.requestCount === requestCount
    ) ?? false
    : false;
}

/** @internal Creates a non-I/O collector; arbitrary callback observers are not accepted. */
export function createSafeDownloadDiagnosticObserver(): SafeDownloadDiagnosticObserver {
  const observer = Object.freeze({
    [SAFE_DOWNLOAD_DIAGNOSTIC_BRAND]: true as const,
    snapshot(): readonly SafeDownloadDiagnosticEvent[] {
      const store = SAFE_DOWNLOAD_DIAGNOSTIC_STORES.get(observer);
      return Object.freeze([...(store?.events ?? [])]);
    }
  });
  SAFE_DOWNLOAD_DIAGNOSTIC_STORES.set(observer, { events: [] });
  return observer;
}

function boundedDiagnosticCount(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000
    ? value as number
    : fallback;
}

/** @internal Records only closed, structural fields and silently ignores foreign observers. */
export function recordSafeDownloadDiagnostic(
  observer: SafeDownloadDiagnosticObserver | undefined,
  update: SafeDownloadDiagnosticUpdate
): void {
  if (!observer) return;
  const store = SAFE_DOWNLOAD_DIAGNOSTIC_STORES.get(observer);
  if (!store) return;
  const previous = store.events.at(-1);
  const event: SafeDownloadDiagnosticEvent = Object.freeze({
    phase: update.phase,
    requestCount: boundedDiagnosticCount(update.requestCount, previous?.requestCount ?? 0),
    approvedHostname: update.approvedHostname ?? previous?.approvedHostname ?? "none",
    scheme: update.scheme ?? previous?.scheme ?? "unknown",
    effectivePort: update.effectivePort ?? previous?.effectivePort ?? "unknown",
    redirectCount: boundedDiagnosticCount(update.redirectCount, previous?.redirectCount ?? 0),
    statusClass: update.statusClass ?? previous?.statusClass ?? "no-response",
    contentCategory: update.contentCategory ?? previous?.contentCategory ?? "unknown",
    contentLengthPresent: update.contentLengthPresent ?? previous?.contentLengthPresent ?? "unknown",
    boundedBytesCategory: update.boundedBytesCategory ?? previous?.boundedBytesCategory ?? "unknown",
    terminationCategory: update.terminationCategory ?? previous?.terminationCategory ?? "unknown",
    cleanupResult: update.cleanupResult ?? previous?.cleanupResult ?? "not-required",
    safeErrorCode: update.safeErrorCode ?? previous?.safeErrorCode ?? "none"
  });
  if (
    previous &&
    previous.phase === event.phase &&
    previous.requestCount === event.requestCount &&
    previous.redirectCount === event.redirectCount &&
    previous.statusClass === event.statusClass &&
    previous.contentCategory === event.contentCategory &&
    previous.contentLengthPresent === event.contentLengthPresent &&
    previous.boundedBytesCategory === event.boundedBytesCategory &&
    previous.terminationCategory === event.terminationCategory &&
    previous.cleanupResult === event.cleanupResult &&
    previous.safeErrorCode === event.safeErrorCode
  ) return;
  if (store.events.length >= 256) return;
  store.events.push(event);
}

/** @internal Closed classifications used by safe diagnostic events and deterministic tests. */
export function classifySafeDownloadStatus(statusCode: number | undefined): SafeDownloadDiagnosticStatusClass {
  if (statusCode === undefined || statusCode === 0) return "no-response";
  if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) return "unknown";
  return `${Math.floor(statusCode / 100)}xx` as SafeDownloadDiagnosticStatusClass;
}

/** @internal Never returns the raw Content-Type value. */
export function classifySafeDownloadContent(contentType: string | undefined): SafeDownloadDiagnosticContentCategory {
  if (contentType === undefined) return "missing";
  const normalized = contentType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (!normalized) return "empty";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/mp4" || normalized === "application/octet-stream") return "binary";
  if (normalized === "text/html" || normalized === "application/xhtml+xml") return "html";
  if (normalized === "application/json" || normalized.endsWith("+json")) return "json";
  if (normalized.startsWith("text/")) return "text";
  return "unknown";
}

/** @internal Converts byte counts to bounded evidence only. */
export function classifySafeDownloadBytes(sizeBytes: number, maxBytes: number): SafeDownloadDiagnosticBytesCategory {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return "unknown";
  if (sizeBytes === 0) return "zero";
  if (sizeBytes > maxBytes) return "over-limit";
  if (sizeBytes === maxBytes) return "at-limit";
  if (sizeBytes <= 64 * 1024) return "small";
  return "within-budget";
}

/** @internal Returns transport fields without retaining any hostname, path, or query. */
export function classifySafeDownloadTransport(url: URL): Readonly<{
  scheme: SafeDownloadDiagnosticScheme;
  effectivePort: SafeDownloadDiagnosticPort;
}> {
  const scheme: SafeDownloadDiagnosticScheme = url.protocol === "https:"
    ? "https"
    : url.protocol === "http:"
      ? "http"
      : "other";
  const effectivePort: SafeDownloadDiagnosticPort = url.port
    ? url.port === "443"
      ? 443
      : url.port === "80"
        ? 80
        : "custom"
    : scheme === "https"
      ? 443
      : scheme === "http"
        ? 80
        : "unknown";
  return Object.freeze({ scheme, effectivePort });
}

function assertSafeUrl(
  url: URL,
  redirect = false,
  requireHttps = false,
  allowHostname: (hostname: string) => boolean = () => true
): URL {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(API_ERROR_CODES.INVALID_URL, "Разрешены только HTTP(S)-ссылки.", 400);
  }

  if (requireHttps && (url.protocol !== "https:" || url.port && url.port !== "443")) {
    throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Источник нарушил HTTPS transport policy.", 502);
  }

  if (url.username || url.password) {
    throw new AppError(API_ERROR_CODES.INVALID_URL, "Ссылка не должна содержать логин или пароль.", 400);
  }

  const safety = redirect ? validateRedirectHostname(url.hostname) : validateOutboundHostname(url.hostname);
  if (!safety.ok) {
    throw new AppError(safety.code, safety.message, 400);
  }

  url.hostname = safety.hostname;
  if (!allowHostname(url.hostname)) {
    throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Источник нарушил platform egress policy.", 502);
  }

  return url;
}

function normalizeHeaderValue(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return value;
}

function normalizeHeaders(headers: http.IncomingHttpHeaders): SafeHeaders {
  const normalized: SafeHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerValue = normalizeHeaderValue(value);
    if (headerValue !== undefined) normalized[key.toLowerCase()] = headerValue;
  }
  return normalized;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function getRequestModule(url: URL): typeof http | typeof https {
  return url.protocol === "https:" ? https : http;
}

export async function resolveSafeAddress(
  hostname: string,
  timeoutSeconds: number,
  signal: AbortSignal,
  lookupAddresses: SafeAddressLookup = (value) => lookup(value, { all: true, verbatim: false })
): Promise<{ address: string; family: 4 | 6 }> {
  const outboundSafety = validateOutboundHostname(hostname);
  if (!outboundSafety.ok) {
    throw new AppError(outboundSafety.code, outboundSafety.message, 400);
  }

  let addresses;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    addresses = await Promise.race([
      lookupAddresses(outboundSafety.hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("dns-timeout")), timeoutSeconds * 1_000);
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(createAbortError());
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      })
    ]);
  } catch {
    if (signal.aborted) throw createAbortError();
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Не удалось проверить адрес источника.", 502);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }

  if (addresses.length === 0) {
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Не удалось проверить адрес источника.", 502);
  }

  const canonicalAddresses: Array<{ address: string; family: 4 | 6 }> = [];
  for (const address of addresses) {
    const addressSafety = validateOutboundHostname(address.address);
    if (!addressSafety.ok) {
      throw new AppError(addressSafety.code, addressSafety.message, 400);
    }
    const family = isIP(addressSafety.hostname);
    if (family !== 4 && family !== 6) {
      throw new AppError(API_ERROR_CODES.PRIVATE_OR_LOCAL_URL, "Локальные и внутренние адреса не поддерживаются.", 400);
    }
    canonicalAddresses.push({ address: addressSafety.hostname, family });
  }

  return canonicalAddresses[0];
}

export function getRedirectTarget(
  currentUrl: URL,
  location: string | undefined,
  requireHttps = false,
  allowHostname: (hostname: string) => boolean = () => true
): URL {
  if (!location) {
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник вернул redirect без Location.", 502);
  }

  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw new AppError(API_ERROR_CODES.INVALID_URL, "Источник вернул некорректный redirect.", 400);
  }

  target.hash = "";
  return assertSafeUrl(target, true, requireHttps, allowHostname);
}

function createAbortError(): AppError {
  return new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Запрос к источнику был остановлен.", 502);
}

function diagnosticErrorCode(error: unknown, fallback: ApiErrorCode): ApiErrorCode {
  return error instanceof AppError ? error.code : fallback;
}

function diagnosticTermination(
  error: unknown,
  signal: AbortSignal,
  fallback: SafeDownloadDiagnosticTermination
): SafeDownloadDiagnosticTermination {
  if (signal.aborted) return "cancelled";
  if (error instanceof AppError) {
    if (error.status === 504 || error.code === API_ERROR_CODES.EXTRACTOR_TIMEOUT) return "timeout";
    if (error.code === API_ERROR_CODES.FILE_TOO_LARGE) return "byte-limit";
    if (error.code === API_ERROR_CODES.OUTPUT_INVALID || error.code === API_ERROR_CODES.SOURCE_EXPIRED) return "validation";
  }
  return fallback;
}

async function requestOnce(url: URL, method: RequestMethod, headers: SafeHeaders, options: ResolvedSafeFetchOptions): Promise<RequestResult> {
  assertSafeUrl(url, false, options.requireHttps, options.allowHostname);
  const resolved = await resolveSafeAddress(url.hostname, options.timeoutSeconds, options.signal);
  const requestCount = lastSafeDownloadDiagnosticEvent(options.diagnosticObserver)?.requestCount ?? 1;
  recordSafeDownloadDiagnostic(options.diagnosticObserver, {
    phase: "dns-ip-validation-completed",
    requestCount
  });
  recordSafeDownloadDiagnostic(options.diagnosticObserver, {
    phase: "media-request-started",
    requestCount
  });

  return new Promise<RequestResult>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(createAbortError());
      return;
    }

    const transport = getRequestModule(url);
    const request = transport.request(
      url,
      {
        method,
        headers: {
          "User-Agent": options.requestProfile === "youtube-public-v1"
            ? YOUTUBE_PUBLIC_USER_AGENT
            : options.requestProfile === "tiktok-public-page-v1"
              ? TIKTOK_PUBLIC_PAGE_USER_AGENT
            : options.requestProfile === "tiktok-media-v1"
              ? TIKTOK_MEDIA_USER_AGENT
            : options.requestProfile === "reddit-public-v1"
              ? REDDIT_PUBLIC_USER_AGENT
              : options.requestProfile === "reddit-media-v1"
                ? REDDIT_MEDIA_USER_AGENT
              : USER_AGENT,
          Accept: options.requestProfile === "youtube-public-v1"
            ? YOUTUBE_PUBLIC_ACCEPT
            : options.requestProfile === "tiktok-public-page-v1"
              ? TIKTOK_PUBLIC_PAGE_ACCEPT
            : options.requestProfile === "tiktok-media-v1"
              ? TIKTOK_MEDIA_ACCEPT
            : options.requestProfile === "reddit-public-v1"
              ? REDDIT_PUBLIC_ACCEPT
              : options.requestProfile === "reddit-media-v1"
                ? REDDIT_MEDIA_ACCEPT
              : "*/*",
          ...(options.requestProfile === "youtube-public-v1"
            ? { "Accept-Language": YOUTUBE_PUBLIC_ACCEPT_LANGUAGE, "Sec-Fetch-Mode": YOUTUBE_PUBLIC_SEC_FETCH_MODE }
            : {}),
          ...(options.requestProfile === "tiktok-media-v1"
            ? { Referer: TIKTOK_MEDIA_REFERER }
            : {}),
          Connection: "close",
          ...headers
        },
        lookup: (_hostname, lookupOptions, callback) => {
          const options = typeof lookupOptions === "object" && lookupOptions !== null ? lookupOptions as RequestLookupOptions : {};
          const done = callback as RequestLookupCallback;
          if (options.all) {
            done(null, [resolved]);
            return;
          }

          done(null, resolved.address, resolved.family);
        },
        maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
        timeout: options.timeoutSeconds * 1000
      },
      (response) => {
        const normalizedHeaders = normalizeHeaders(response.headers);
        const contentType = normalizedHeaders["content-type"]?.split(";")[0]?.trim().toLowerCase();
        const contentLength = parseContentLength(normalizedHeaders["content-length"]);
        recordSafeDownloadDiagnostic(options.diagnosticObserver, {
          phase: "response-received",
          requestCount,
          statusClass: classifySafeDownloadStatus(response.statusCode),
          contentCategory: classifySafeDownloadContent(contentType),
          contentLengthPresent: contentLength === undefined ? "no" : "yes"
        });
        resolve({
          finalUrl: url,
          statusCode: response.statusCode ?? 0,
          headers: normalizedHeaders,
          contentType,
          contentLength,
          stream: response
        });
      }
    );

    const abort = () => {
      request.destroy(createAbortError());
    };

    options.signal.addEventListener("abort", abort, { once: true });

    request.on("timeout", () => {
      request.destroy(new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник не ответил вовремя.", 504));
    });

    request.on("error", (error) => {
      options.signal.removeEventListener("abort", abort);
      reject(error instanceof AppError ? error : new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Не удалось получить ответ источника.", 502));
    });

    request.on("close", () => {
      options.signal.removeEventListener("abort", abort);
    });

    request.end();
  });
}

async function requestWithRedirects(
  initialUrl: URL,
  method: RequestMethod,
  headers: SafeHeaders,
  options: SafeFetchOptions
): Promise<RequestResult> {
  const requestOptions: ResolvedSafeFetchOptions = {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    requireHttps: options.requireHttps ?? false,
    requestProfile: options.requestProfile ?? "default",
    allowHostname: options.allowHostname ?? (() => true),
    signal: options.signal ?? new AbortController().signal,
    diagnosticObserver: options.diagnosticObserver
  };
  const transport = classifySafeDownloadTransport(initialUrl);
  recordSafeDownloadDiagnostic(options.diagnosticObserver, {
    phase: "request-profile-built",
    requestCount: 1,
    ...transport
  });

  let currentUrl: URL;
  try {
    currentUrl = assertSafeUrl(
      new URL(initialUrl.toString()),
      false,
      requestOptions.requireHttps,
      requestOptions.allowHostname
    );
  } catch (error) {
    recordSafeDownloadDiagnostic(options.diagnosticObserver, {
      phase: "failed",
      terminationCategory: "validation",
      safeErrorCode: diagnosticErrorCode(error, API_ERROR_CODES.EXTRACTION_FAILED)
    });
    throw error;
  }
  for (let redirectCount = 0; redirectCount <= requestOptions.maxRedirects; redirectCount += 1) {
    if (redirectCount > 0) {
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "request-profile-built",
        requestCount: redirectCount + 1,
        redirectCount,
        ...classifySafeDownloadTransport(currentUrl)
      });
    }
    let result: RequestResult;
    try {
      result = await requestOnce(currentUrl, method, headers, requestOptions);
    } catch (error) {
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "failed",
        requestCount: redirectCount + 1,
        redirectCount,
        terminationCategory: diagnosticTermination(error, requestOptions.signal, "network"),
        safeErrorCode: diagnosticErrorCode(error, API_ERROR_CODES.EXTRACTION_FAILED)
      });
      throw error;
    }

    if (!isRedirectStatus(result.statusCode)) {
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "http-status-classified",
        requestCount: redirectCount + 1,
        redirectCount,
        statusClass: classifySafeDownloadStatus(result.statusCode)
      });
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "content-type-classified",
        requestCount: redirectCount + 1,
        redirectCount,
        contentCategory: classifySafeDownloadContent(result.contentType),
        contentLengthPresent: result.contentLength === undefined ? "no" : "yes"
      });
      return result;
    }

    result.stream?.destroy();
    recordSafeDownloadDiagnostic(options.diagnosticObserver, {
      phase: "redirect-evaluated",
      requestCount: redirectCount + 1,
      redirectCount: redirectCount + 1,
      statusClass: "3xx"
    });
    if (redirectCount === requestOptions.maxRedirects) {
      const error = new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник вернул слишком много redirect-ов.", 502);
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "failed",
        requestCount: redirectCount + 1,
        redirectCount: redirectCount + 1,
        terminationCategory: "redirect-rejected",
        safeErrorCode: error.code
      });
      throw error;
    }
    try {
      currentUrl = getRedirectTarget(
        currentUrl,
        result.headers.location,
        requestOptions.requireHttps,
        requestOptions.allowHostname
      );
    } catch (error) {
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "failed",
        requestCount: redirectCount + 1,
        redirectCount: redirectCount + 1,
        terminationCategory: "redirect-rejected",
        safeErrorCode: diagnosticErrorCode(error, API_ERROR_CODES.EXTRACTION_FAILED)
      });
      throw error;
    }
  }

  throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник вернул слишком много redirect-ов.", 502);
}

function assertReadableStatus(result: SafeResponseMetadata): void {
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник не вернул доступный медиафайл.", 502, {
      statusCode: result.statusCode
    });
  }
}

export async function safeHead(url: URL, options: SafeFetchOptions = {}): Promise<SafeResponseMetadata> {
  const result = await requestWithRedirects(url, "HEAD", {}, {
    ...options,
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS,
  });
  result.stream?.destroy();
  assertReadableStatus(result);
  return result;
}

export async function safeGetMetadata(url: URL, options: SafeFetchOptions = {}): Promise<SafeResponseMetadata> {
  const result = await requestWithRedirects(url, "GET", { Range: "bytes=0-0" }, {
    ...options,
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS,
  });
  result.stream?.destroy();
  assertReadableStatus(result);
  return result;
}

/** @internal Exported for deterministic response-stream tests without network access. */
export function createSafeBodyFetcher(dependencies: SafeBodyFetcherDependencies) {
  return async function fetchBody(
    url: URL,
    options: SafeBodyFetchOptions
  ): Promise<SafeBodyFetchResult> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > MAX_IN_MEMORY_BODY_BYTES) {
      throw new TypeError("Safe body byte limit is invalid.");
    }
    const signal = options.signal ?? new AbortController().signal;
    const result = await dependencies.requestBody(url, {
      timeoutSeconds: options.timeoutSeconds ?? DEFAULT_METADATA_TIMEOUT_SECONDS,
      maxRedirects: options.maxRedirects,
      requireHttps: options.requireHttps,
      requestProfile: options.requestProfile,
      allowHostname: options.allowHostname,
      signal
    });
    if (typeof result.contentLength === "number" && result.contentLength > options.maxBytes) {
      result.stream?.destroy();
      throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE, "Ответ источника превышает допустимый размер.", 413);
    }
    const stream = result.stream;
    if (!stream) throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник не вернул тело ответа.", 502);

    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    const collector = new Writable({
      write(value: Buffer | Uint8Array | string, _encoding, callback) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        sizeBytes += chunk.length;
        if (sizeBytes > options.maxBytes) {
          callback(new AppError(API_ERROR_CODES.FILE_TOO_LARGE, "Ответ источника превышает допустимый размер.", 413));
          return;
        }
        chunks.push(chunk);
        callback();
      }
    });

    try {
      await pipeline(stream, collector, { signal });
      if (result.contentLength !== undefined && result.contentLength !== sizeBytes) {
        throw new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Источник вернул неполный ответ.", 502);
      }
    } catch (error) {
      stream.destroy();
      collector.destroy();
      if (signal.aborted) throw createAbortError();
      throw error instanceof AppError
        ? error
        : new AppError(API_ERROR_CODES.EXTRACTION_FAILED, "Не удалось прочитать ответ источника.", 502);
    }

    const { stream: _stream, ...metadata } = result;
    return { ...metadata, body: Buffer.concat(chunks, sizeBytes), sizeBytes };
  };
}

export const safeFetchBody = createSafeBodyFetcher({
  requestBody: (url, options) => requestWithRedirects(url, "GET", {}, options)
});

/** @internal Exported for fake-stream tests without real network requests. */
export function createSafeFileDownloader(dependencies: SafeFileDownloaderDependencies) {
  return async function downloadToFile(
    url: URL,
    destinationPath: string,
    options: SafeDownloadOptions
  ): Promise<SafeDownloadResult> {
    const signal = options.signal ?? new AbortController().signal;
    const partialPath = `${destinationPath}.download`;
    const linkFile = dependencies.linkFile ?? link;
    const unlinkFile = dependencies.unlinkFile ?? unlink;
    const removeFile = dependencies.removeFile ?? ((filePath: string) => rm(filePath, { force: true }));
    let result: SafeDownloadStreamResult | undefined;
    let stream: http.IncomingMessage | undefined;
    let file: ReturnType<typeof createWriteStream> | undefined;
    let sizeBytes = 0;
    let finalOwned = false;
    let partialOwned = false;
    let temporaryFinalizationStarted = false;

    try {
      result = await dependencies.requestDownload(url, {
        timeoutSeconds: options.timeoutSeconds ?? DEFAULT_DOWNLOAD_TIMEOUT_SECONDS,
        maxRedirects: options.maxRedirects,
        requireHttps: options.requireHttps,
        requestProfile: options.requestProfile,
        allowHostname: options.allowHostname,
        signal,
        diagnosticObserver: options.diagnosticObserver
      });
      const requestCount = lastSafeDownloadDiagnosticEvent(options.diagnosticObserver)?.requestCount ?? 1;
      if (!hasSafeDownloadDiagnosticPhase(options.diagnosticObserver, "response-received", requestCount)) {
        recordSafeDownloadDiagnostic(options.diagnosticObserver, {
          phase: "response-received",
          requestCount,
          statusClass: classifySafeDownloadStatus(result.statusCode),
          contentCategory: classifySafeDownloadContent(result.contentType),
          contentLengthPresent: result.contentLength === undefined ? "no" : "yes"
        });
      }
      if (!hasSafeDownloadDiagnosticPhase(options.diagnosticObserver, "http-status-classified", requestCount)) {
        recordSafeDownloadDiagnostic(options.diagnosticObserver, {
          phase: "http-status-classified",
          requestCount,
          statusClass: classifySafeDownloadStatus(result.statusCode)
        });
      }
      assertReadableStatus(result);
      if (!hasSafeDownloadDiagnosticPhase(options.diagnosticObserver, "content-type-classified", requestCount)) {
        recordSafeDownloadDiagnostic(options.diagnosticObserver, {
          phase: "content-type-classified",
          requestCount,
          contentCategory: classifySafeDownloadContent(result.contentType),
          contentLengthPresent: result.contentLength === undefined ? "no" : "yes"
        });
      }

      if (typeof result.contentLength === "number" && result.contentLength > options.maxBytes) {
        result.stream?.destroy();
        recordSafeDownloadDiagnostic(options.diagnosticObserver, {
          phase: "byte-budget-evaluated",
          boundedBytesCategory: "over-limit"
        });
        throw new AppError(API_ERROR_CODES.FILE_TOO_LARGE, "Файл превышает допустимый размер.", 413);
      }

      stream = result.stream;
      if (!stream) {
        throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Источник не вернул тело файла.", 502);
      }

      file = createWriteStream(partialPath, { flags: "wx" });
      const totalBytes = result.contentLength;
      file.once("open", () => {
        partialOwned = true;
      });
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          if (isSafeDownloadDiagnosticObserver(options.diagnosticObserver)) {
            recordSafeDownloadDiagnostic(options.diagnosticObserver, {
              phase: "byte-budget-evaluated",
              boundedBytesCategory: classifySafeDownloadBytes(sizeBytes, options.maxBytes)
            });
          }
          if (sizeBytes > options.maxBytes) {
            callback(new AppError(API_ERROR_CODES.FILE_TOO_LARGE, "Файл превышает допустимый размер.", 413));
            return;
          }
          try {
            options.onProgress?.(sizeBytes, totalBytes);
          } catch {
            // Progress observers must not affect download integrity.
          }
          callback(null, chunk);
        }
      });
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "body-streaming-started",
        boundedBytesCategory: "zero"
      });
      await pipeline(stream, meter, file, { signal });
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "body-streaming-completed",
        boundedBytesCategory: classifySafeDownloadBytes(sizeBytes, options.maxBytes)
      });
      if (sizeBytes <= 0 || (totalBytes !== undefined && sizeBytes !== totalBytes)) {
        throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Источник вернул неполный медиафайл.", 502);
      }

      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "byte-budget-evaluated",
        boundedBytesCategory: classifySafeDownloadBytes(sizeBytes, options.maxBytes)
      });
      temporaryFinalizationStarted = true;
      await linkFile(partialPath, destinationPath);
      finalOwned = true;
      await unlinkFile(partialPath);
      partialOwned = false;
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "temporary-file-finalized",
        boundedBytesCategory: classifySafeDownloadBytes(sizeBytes, options.maxBytes),
        terminationCategory: "success"
      });
    } catch (error) {
      file?.destroy();
      stream?.destroy();
      let cleanupResult: SafeDownloadDiagnosticCleanup = "not-required";
      if (partialOwned || finalOwned) {
        const cleanup = await Promise.all([
          partialOwned ? removeFile(partialPath) : Promise.resolve(),
          finalOwned ? removeFile(destinationPath) : Promise.resolve()
        ].map((operation) => operation.then(() => true, () => false)));
        cleanupResult = cleanup.every(Boolean) ? "success" : "failure";
      }
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "cleanup-completed",
        cleanupResult,
        terminationCategory: cleanupResult === "failure" ? "cleanup" : "unknown"
      });
      const safeError = signal.aborted
        ? createAbortError()
        : error instanceof AppError
          ? error
          : new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Не удалось сохранить файл.", 500);
      const thrownError = !signal.aborted && !result && !(error instanceof AppError)
        ? error
        : safeError;
      let fallbackTermination: SafeDownloadDiagnosticTermination = "network";
      if (cleanupResult === "failure") fallbackTermination = "cleanup";
      else if (temporaryFinalizationStarted) fallbackTermination = "filesystem";
      else if (result && (result.statusCode < 200 || result.statusCode >= 300 || !result.stream)) {
        fallbackTermination = "response-rejected";
      }
      recordSafeDownloadDiagnostic(options.diagnosticObserver, {
        phase: "failed",
        cleanupResult,
        terminationCategory: diagnosticTermination(safeError, signal, fallbackTermination),
        safeErrorCode: safeError.code,
        boundedBytesCategory: classifySafeDownloadBytes(sizeBytes, options.maxBytes)
      });
      throw thrownError;
    }

    if (!result) throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
    const { stream: _stream, ...metadata } = result;
    return { ...metadata, sizeBytes };
  };
}

export const safeDownloadToFile = createSafeFileDownloader({
  requestDownload: (url, options) => requestWithRedirects(url, "GET", {}, options)
});
