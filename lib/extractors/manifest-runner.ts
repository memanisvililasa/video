import "server-only";
import { AppError } from "@/lib/errors";
import {
  safeFetchBody,
  type SafeBodyFetchOptions,
  type SafeBodyFetchResult
} from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

export type ManifestBodyFetcher = (
  url: URL,
  options: SafeBodyFetchOptions
) => Promise<SafeBodyFetchResult>;

export type ManifestDocument = Readonly<{
  finalUrl: URL;
  contentType: string;
  body: Buffer;
  sizeBytes: number;
}>;

export type ManifestRunner = Readonly<{
  fetch(url: URL, options?: Readonly<{
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }>): Promise<ManifestDocument>;
}>;

export type CreateManifestRunnerOptions = Readonly<{
  fetchBody?: ManifestBodyFetcher;
  maxBytes: number;
  maxRedirects: number;
  defaultTimeoutSeconds: number;
  maximumTimeoutSeconds: number;
  requestProfile: NonNullable<SafeBodyFetchOptions["requestProfile"]>;
  contentTypes: ReadonlySet<string>;
  allowHostname(hostname: string): boolean;
}>;

function failed(): AppError {
  return new AppError(API_ERROR_CODES.EXTRACTOR_FAILED);
}

/** @internal Bounded transport adapter; platform parsers own document semantics. */
export function createManifestRunner(options: CreateManifestRunnerOptions): ManifestRunner {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > 8 * 1024 * 1024) {
    throw new TypeError("Manifest byte limit is invalid.");
  }
  if (!Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0 || options.maxRedirects > 5) {
    throw new TypeError("Manifest redirect limit is invalid.");
  }
  if (
    !Number.isFinite(options.defaultTimeoutSeconds) ||
    !Number.isFinite(options.maximumTimeoutSeconds) ||
    options.defaultTimeoutSeconds <= 0 ||
    options.maximumTimeoutSeconds < options.defaultTimeoutSeconds ||
    options.maximumTimeoutSeconds > 60
  ) throw new TypeError("Manifest timeout limit is invalid.");
  if (options.contentTypes.size === 0) throw new TypeError("Manifest Content-Type allowlist is empty.");
  const fetchBody = options.fetchBody ?? safeFetchBody;
  return Object.freeze({
    async fetch(url, request = {}): Promise<ManifestDocument> {
      const timeoutSeconds = request.timeoutSeconds ?? options.defaultTimeoutSeconds;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > options.maximumTimeoutSeconds) {
        throw new TypeError("Manifest request timeout is invalid.");
      }
      const result = await fetchBody(url, {
        maxBytes: options.maxBytes,
        timeoutSeconds,
        maxRedirects: options.maxRedirects,
        requireHttps: true,
        requestProfile: options.requestProfile,
        allowHostname: options.allowHostname,
        signal: request.signal
      });
      if (
        result.statusCode < 200 ||
        result.statusCode >= 300 ||
        !result.contentType ||
        !options.contentTypes.has(result.contentType) ||
        result.sizeBytes !== result.body.length ||
        result.sizeBytes <= 0 ||
        result.sizeBytes > options.maxBytes
      ) throw failed();
      return Object.freeze({
        finalUrl: result.finalUrl,
        contentType: result.contentType,
        body: result.body,
        sizeBytes: result.sizeBytes
      });
    }
  });
}
