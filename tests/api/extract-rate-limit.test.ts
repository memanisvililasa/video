import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_MESSAGES } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  requireExtractor: vi.fn()
}));

vi.mock("@/lib/security/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/extractors/registry", () => ({ requireExtractor: mocks.requireExtractor }));

import { POST } from "@/app/api/extract/route";

describe("POST /api/extract rate-limit regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockReturnValue({
      ok: false,
      allowed: false,
      bucket: "extract",
      key: "extract:unidentified",
      limit: 30,
      remaining: 0,
      resetAt: Date.now() + 17_000,
      retryAfterSeconds: 17,
      error: {
        code: API_ERROR_CODES.RATE_LIMITED,
        message: API_ERROR_MESSAGES.RATE_LIMITED,
        details: { bucket: "extract", retryAfterSeconds: 17 }
      },
      code: API_ERROR_CODES.RATE_LIMITED,
      message: API_ERROR_MESSAGES.RATE_LIMITED
    });
  });

  it("keeps 429 and Retry-After without invoking an extractor", async () => {
    const response = await POST(new NextRequest("http://localhost/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.4"
      },
      body: JSON.stringify({ url: "https://public.example/video.mp4" })
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.RATE_LIMITED }
    });
    expect(mocks.requireExtractor).not.toHaveBeenCalled();
  });
});
