import "server-only";
import { isIP } from "node:net";
import { AppError } from "@/lib/errors";
import {
  classifySafeDownloadTransport,
  recordSafeDownloadDiagnostic,
  type SafeDownloadDiagnosticHostname,
  type SafeDownloadDiagnosticObserver
} from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

export const TIKTOK_MEDIA_HOSTS = Object.freeze([
  "v16-webapp-prime.tiktok.com",
  "v19-webapp-prime.tiktok.com"
] as const);

export const TIKTOK_LOCATOR_SAFETY_WINDOW_SECONDS = 30;
const MAX_LOCATOR_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const MEDIA_HOST_SET: ReadonlySet<string> = new Set(TIKTOK_MEDIA_HOSTS);

export type TikTokValidatedLocator = Readonly<{
  url: URL;
  expiresAtEpochSeconds: number;
}>;

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function locatorInvalid(): AppError {
  return new AppError(API_ERROR_CODES.DOWNLOAD_FAILED);
}

function diagnosticHostname(hostname: string): SafeDownloadDiagnosticHostname {
  const normalized = normalizedHostname(hostname);
  return normalized === TIKTOK_MEDIA_HOSTS[0] || normalized === TIKTOK_MEDIA_HOSTS[1]
    ? normalized
    : "unapproved";
}

function diagnosticValidationFailure(
  observer: SafeDownloadDiagnosticObserver | undefined,
  error: AppError
): never {
  recordSafeDownloadDiagnostic(observer, {
    phase: "failed",
    terminationCategory: "validation",
    safeErrorCode: error.code
  });
  throw error;
}

export function isTikTokMediaHostname(hostname: string): boolean {
  return MEDIA_HOST_SET.has(normalizedHostname(hostname));
}

export function validateTikTokMediaLocator(
  input: URL,
  nowMs = Date.now(),
  diagnosticObserver?: SafeDownloadDiagnosticObserver
): TikTokValidatedLocator {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("TikTok locator clock is invalid.");
  const url = new URL(input.toString());
  url.hash = "";
  const hostname = normalizedHostname(url.hostname);
  recordSafeDownloadDiagnostic(diagnosticObserver, {
    phase: "locator-validation-started",
    approvedHostname: diagnosticHostname(hostname),
    ...classifySafeDownloadTransport(url)
  });
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(hostname) !== 0 ||
    !MEDIA_HOST_SET.has(hostname)
  ) diagnosticValidationFailure(diagnosticObserver, locatorInvalid());
  url.hostname = hostname;
  recordSafeDownloadDiagnostic(diagnosticObserver, {
    phase: "locator-validated",
    approvedHostname: diagnosticHostname(hostname),
    ...classifySafeDownloadTransport(url)
  });

  const expiryValues = url.searchParams.getAll("expire");
  if (expiryValues.length !== 1 || !/^[0-9]{10}$/.test(expiryValues[0] ?? "")) {
    diagnosticValidationFailure(diagnosticObserver, locatorInvalid());
  }
  const expiresAtEpochSeconds = Number(expiryValues[0]);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    !Number.isSafeInteger(expiresAtEpochSeconds) ||
    expiresAtEpochSeconds - nowSeconds < TIKTOK_LOCATOR_SAFETY_WINDOW_SECONDS ||
    expiresAtEpochSeconds - nowSeconds > MAX_LOCATOR_LIFETIME_SECONDS
  ) diagnosticValidationFailure(diagnosticObserver, new AppError(API_ERROR_CODES.SOURCE_EXPIRED));

  recordSafeDownloadDiagnostic(diagnosticObserver, {
    phase: "expiry-validated"
  });

  return Object.freeze({ url, expiresAtEpochSeconds });
}
