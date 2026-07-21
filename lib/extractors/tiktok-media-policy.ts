import "server-only";
import { isIP } from "node:net";
import { AppError } from "@/lib/errors";
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

export function isTikTokMediaHostname(hostname: string): boolean {
  return MEDIA_HOST_SET.has(normalizedHostname(hostname));
}

export function validateTikTokMediaLocator(
  input: URL,
  nowMs = Date.now()
): TikTokValidatedLocator {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("TikTok locator clock is invalid.");
  const url = new URL(input.toString());
  url.hash = "";
  const hostname = normalizedHostname(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    isIP(hostname) !== 0 ||
    !MEDIA_HOST_SET.has(hostname)
  ) throw locatorInvalid();
  url.hostname = hostname;

  const expiryValues = url.searchParams.getAll("expire");
  if (expiryValues.length !== 1 || !/^[0-9]{10}$/.test(expiryValues[0] ?? "")) {
    throw locatorInvalid();
  }
  const expiresAtEpochSeconds = Number(expiryValues[0]);
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    !Number.isSafeInteger(expiresAtEpochSeconds) ||
    expiresAtEpochSeconds - nowSeconds < TIKTOK_LOCATOR_SAFETY_WINDOW_SECONDS ||
    expiresAtEpochSeconds - nowSeconds > MAX_LOCATOR_LIFETIME_SECONDS
  ) throw new AppError(API_ERROR_CODES.SOURCE_EXPIRED);

  return Object.freeze({ url, expiresAtEpochSeconds });
}
