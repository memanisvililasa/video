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
});
