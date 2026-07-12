import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_MESSAGES } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getPreparedFile: vi.fn()
}));

vi.mock("@/lib/security/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/storage/local-storage", () => ({ getPreparedFile: mocks.getPreparedFile }));

import { GET } from "@/app/api/file/[id]/route";

describe("GET /api/file/[id] rate-limit regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockReturnValue({
      ok: false,
      allowed: false,
      bucket: "file",
      key: "file:unidentified",
      limit: 120,
      remaining: 0,
      resetAt: Date.now() + 19_000,
      retryAfterSeconds: 19,
      error: {
        code: API_ERROR_CODES.RATE_LIMITED,
        message: API_ERROR_MESSAGES.RATE_LIMITED,
        details: { bucket: "file", retryAfterSeconds: 19 }
      },
      code: API_ERROR_CODES.RATE_LIMITED,
      message: API_ERROR_MESSAGES.RATE_LIMITED
    });
  });

  it("keeps 429 and Retry-After without looking up or streaming a file", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/file/file_0123456789", {
        headers: { "X-Real-IP": "203.0.113.8" }
      }),
      { params: Promise.resolve({ id: "file_0123456789" }) }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("19");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: API_ERROR_CODES.RATE_LIMITED }
    });
    expect(mocks.getPreparedFile).not.toHaveBeenCalled();
  });
});
