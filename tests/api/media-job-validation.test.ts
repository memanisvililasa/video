import { describe, expect, it } from "vitest";
import { PROCESSING_PRESETS, isProcessingPreset } from "@/lib/api/media-job-dto";
import { parseCreateDownloadJobRequest, parseJobId } from "@/lib/api/media-job-validation";
import { AppError } from "@/lib/errors";
import { API_ERROR_CODES, type ApiErrorCode } from "@/lib/types";

function validBody(processingPreset: string = "original"): Record<string, unknown> {
  return {
    url: " https://public.example/video.mp4 ",
    formatId: "direct-source",
    processingPreset,
    rightsConfirmed: true
  };
}

function expectAppError(operation: () => unknown, code: ApiErrorCode): void {
  try {
    operation();
    throw new Error("Expected AppError.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe("media job processing presets", () => {
  it("exposes the complete readonly allowlist and rejects arbitrary strings", () => {
    expect(PROCESSING_PRESETS).toEqual([
      "original",
      "remux-to-mp4",
      "compatible-mp4",
      "audio-only"
    ]);
    expect(Object.isFrozen(PROCESSING_PRESETS)).toBe(true);
    expect(isProcessingPreset("original")).toBe(true);
    expect(isProcessingPreset("custom")).toBe(false);
    expect(isProcessingPreset(1)).toBe(false);
  });
});

describe("parseCreateDownloadJobRequest", () => {
  it.each(PROCESSING_PRESETS)("parses the %s preset", (processingPreset) => {
    const parsed = parseCreateDownloadJobRequest(validBody(processingPreset));
    expect(parsed).toEqual({
      url: "https://public.example/video.mp4",
      formatId: "direct-source",
      processingPreset,
      rightsConfirmed: true
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([null, [], "body", 10, true])("rejects a non-object body: %j", (body) => {
    expectAppError(() => parseCreateDownloadJobRequest(body), API_ERROR_CODES.INVALID_REQUEST);
  });

  it("rejects a missing or empty URL as INVALID_REQUEST", () => {
    const missing = validBody();
    delete missing.url;
    expectAppError(() => parseCreateDownloadJobRequest(missing), API_ERROR_CODES.INVALID_REQUEST);
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), url: "   " }),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it("rejects a missing or malformed formatId as INVALID_FORMAT", () => {
    const missing = validBody();
    delete missing.formatId;
    expectAppError(() => parseCreateDownloadJobRequest(missing), API_ERROR_CODES.INVALID_FORMAT);
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), formatId: "../../secret" }),
      API_ERROR_CODES.INVALID_FORMAT
    );
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), formatId: "format id" }),
      API_ERROR_CODES.INVALID_FORMAT
    );
  });

  it("requires rightsConfirmed to be literal true", () => {
    const missing = validBody();
    delete missing.rightsConfirmed;
    expectAppError(() => parseCreateDownloadJobRequest(missing), API_ERROR_CODES.RIGHTS_NOT_CONFIRMED);
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), rightsConfirmed: false }),
      API_ERROR_CODES.RIGHTS_NOT_CONFIRMED
    );
  });

  it("rejects an unsupported or missing preset", () => {
    expectAppError(
      () => parseCreateDownloadJobRequest(validBody("enhance-4k")),
      API_ERROR_CODES.UNSUPPORTED_PRESET
    );
    const missing = validBody();
    delete missing.processingPreset;
    expectAppError(() => parseCreateDownloadJobRequest(missing), API_ERROR_CODES.UNSUPPORTED_PRESET);
  });

  it("rejects unexpected fields", () => {
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), path: "/private/output.mp4" }),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it("rejects oversized strings and control characters", () => {
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), url: `https://example.com/${"a".repeat(2_100)}` }),
      API_ERROR_CODES.INVALID_REQUEST
    );
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), url: "https://example.com/\u0000video" }),
      API_ERROR_CODES.INVALID_REQUEST
    );
    expectAppError(
      () => parseCreateDownloadJobRequest({ ...validBody(), formatId: "a".repeat(65) }),
      API_ERROR_CODES.INVALID_FORMAT
    );
  });
});

describe("parseJobId", () => {
  it("accepts a bounded server-generated job ID", () => {
    expect(parseJobId("job_0123456789abcdef")).toBe("job_0123456789abcdef");
    expect(parseJobId(`job_${"a".repeat(124)}`)).toHaveLength(128);
  });

  it.each([
    "",
    "job_",
    `job_${"a".repeat(125)}`,
    "job_one/two",
    "job_one\\two",
    "job_../secret",
    "job_bad\u0000id",
    "job_bad id",
    "file_012345"
  ])("rejects an unsafe job ID: %j", (jobId) => {
    expectAppError(() => parseJobId(jobId), API_ERROR_CODES.INVALID_REQUEST);
  });
});
