import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/extract/route";
import { API_ERROR_CODES } from "@/lib/types";

describe("X/Twitter production isolation", () => {
  it("keeps the public extract route on the disabled placeholder without network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await POST(new NextRequest("http://localhost/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://x.com/synthetic_user/status/700000000000000001"
        })
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        ok: false,
        error: expect.objectContaining({ code: API_ERROR_CODES.UNSUPPORTED_URL })
      });
      expect(JSON.stringify(body)).not.toMatch(/700000000000000001|synthetic_user|metadata|format|mediaUrl|cdnUrl|signed/i);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects t.co without redirect resolution, transport, or diagnostic leakage", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await POST(new NextRequest("http://localhost/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://t.co/SyntheticCode" })
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        ok: false,
        error: expect.objectContaining({ code: API_ERROR_CODES.UNSUPPORTED_URL })
      });
      expect(JSON.stringify(body)).not.toMatch(/SyntheticCode|redirect|transport|t\.co/i);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
