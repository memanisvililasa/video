import { describe, expect, it } from "vitest";
import { API_ERROR_MESSAGES, API_ERROR_STATUS, AppError, getApiErrorStatus } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

describe("media job request error model", () => {
  it.each([
    [API_ERROR_CODES.INVALID_REQUEST, 400],
    [API_ERROR_CODES.RIGHTS_NOT_CONFIRMED, 403],
    [API_ERROR_CODES.UNSUPPORTED_PRESET, 422],
    [API_ERROR_CODES.INVALID_FORMAT, 422]
  ] as const)("maps %s to HTTP %s with a safe canonical message", (code, status) => {
    const error = new AppError(code);
    expect(error.code).toBe(code);
    expect(error.message).toBe(API_ERROR_MESSAGES[code]);
    expect(API_ERROR_STATUS[code]).toBe(status);
    expect(getApiErrorStatus(error)).toBe(status);

    const message = error.message.toLowerCase();
    for (const forbidden of ["http://", "https://", "/private/", "stderr", "stack", "ffmpeg", "-map"]) {
      expect(message).not.toContain(forbidden);
    }
  });

  it.each([
    API_ERROR_CODES.UNSUPPORTED_PLATFORM,
    API_ERROR_CODES.UNSUPPORTED_URL,
    API_ERROR_CODES.CONTENT_UNAVAILABLE,
    API_ERROR_CODES.LOGIN_REQUIRED,
    API_ERROR_CODES.PRIVATE_CONTENT,
    API_ERROR_CODES.MEMBERS_ONLY,
    API_ERROR_CODES.DRM_PROTECTED,
    API_ERROR_CODES.GEO_RESTRICTED,
    API_ERROR_CODES.REGION_RESTRICTED,
    API_ERROR_CODES.AGE_RESTRICTED,
    API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE,
    API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED,
    API_ERROR_CODES.IMAGE_POST_NOT_SUPPORTED,
    API_ERROR_CODES.CAROUSEL_NOT_SUPPORTED,
    API_ERROR_CODES.STORY_NOT_SUPPORTED,
    API_ERROR_CODES.LIVE_NOT_SUPPORTED,
    API_ERROR_CODES.PLAYLIST_NOT_SUPPORTED,
    API_ERROR_CODES.EXTERNAL_MEDIA_NOT_SUPPORTED,
    API_ERROR_CODES.POST_HAS_NO_VIDEO,
    API_ERROR_CODES.GALLERY_NOT_SUPPORTED,
    API_ERROR_CODES.SOURCE_HAS_NO_AUDIO,
    API_ERROR_CODES.NO_SUPPORTED_FORMAT,
    API_ERROR_CODES.EXTRACTOR_TIMEOUT,
    API_ERROR_CODES.EXTRACTOR_FAILED,
    API_ERROR_CODES.SOURCE_EXPIRED,
    API_ERROR_CODES.DOWNLOAD_FAILED,
    API_ERROR_CODES.MERGE_FAILED,
    API_ERROR_CODES.OUTPUT_INVALID
  ])("exposes a stable redacted public message for a platform boundary code %s", (code) => {
    const error = new AppError(code);
    expect(error.message).toBe(API_ERROR_MESSAGES[code]);
    expect(error.message).not.toMatch(/https?:\/\/|stderr|yt-dlp|\/private\/|signature=|cookie|authorization/i);
    expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(API_ERROR_STATUS[code]).toBeLessThan(600);
  });
});
