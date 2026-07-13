import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { classifyWorkerError } from "@/lib/worker/errors";
import { API_ERROR_CODES } from "@/lib/types";

describe("worker error classification", () => {
  it("separates terminal policy failures from retryable operational failures", () => {
    expect(classifyWorkerError(new AppError(API_ERROR_CODES.INVALID_MEDIA_FILE), null)).toEqual({
      type: "terminal",
      code: API_ERROR_CODES.INVALID_MEDIA_FILE
    });
    expect(classifyWorkerError(new AppError(API_ERROR_CODES.EXTRACTION_FAILED), null)).toEqual({
      type: "retryable",
      code: API_ERROR_CODES.EXTRACTION_FAILED
    });
  });

  it("lets persistent control state override a lower-level process error", () => {
    expect(classifyWorkerError(new AppError(API_ERROR_CODES.PROCESSING_FAILED), "cancellation")).toEqual({ type: "cancelled" });
    expect(classifyWorkerError(new AppError(API_ERROR_CODES.JOB_CANCELLED), null)).toEqual({ type: "cancelled" });
    expect(classifyWorkerError(new Error("transport"), "db-transport")).toEqual({ type: "ownership-lost" });
    expect(classifyWorkerError(new Error("timeout"), "attempt-timeout")).toEqual({
      type: "terminal",
      code: API_ERROR_CODES.PROCESSING_TIMEOUT
    });
  });
});
