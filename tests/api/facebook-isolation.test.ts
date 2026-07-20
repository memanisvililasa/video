import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/extract/route";
import { API_ERROR_CODES } from "@/lib/types";

describe("Facebook production isolation", () => {
  it("keeps the public extract route on the disabled placeholder without network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const response = await POST(new NextRequest("http://localhost/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://www.facebook.com/watch/?v=700000000000001"
        })
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        ok: false,
        error: expect.objectContaining({ code: API_ERROR_CODES.UNSUPPORTED_URL })
      });
      expect(JSON.stringify(body)).not.toMatch(/700000000000001|metadata|format|mediaUrl|cdnUrl|signed/i);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
