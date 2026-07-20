import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createFacebookShortLinkResolver,
  type FacebookShortLinkHeadResponse,
  type FacebookShortLinkResolverDependencies
} from "@/lib/extractors/facebook-short-link";
import { classifyFacebookUrl, type FacebookShortLinkIdentity } from "@/lib/extractors/facebook-url";
import { API_ERROR_CODES } from "@/lib/types";

const CONTENT_ID = "700000000000001";
const PUBLIC_ADDRESS = Object.freeze({ address: "1.1.1.1", family: 4 as const });

function short(value = "https://fb.watch/SynthCode/"): FacebookShortLinkIdentity {
  const identity = classifyFacebookUrl(new URL(value));
  if (identity.sourceKind !== "short-link") throw new Error("Expected short link.");
  return identity;
}

function dependencies(
  responses: readonly FacebookShortLinkHeadResponse[],
  overrides: Partial<FacebookShortLinkResolverDependencies> = {}
): FacebookShortLinkResolverDependencies {
  let index = 0;
  return {
    resolveAddress: vi.fn(async () => PUBLIC_ADDRESS),
    requestHead: vi.fn(async (request) => {
      expect(request.method).toBe("HEAD");
      return responses[index++] ?? { statusCode: 500, headerBytes: 0 };
    }),
    ...overrides
  };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as Error).message).not.toMatch(/https?:\/\/|SynthCode|700000000000001/i);
  }
}

describe("controlled Facebook short-link resolver", () => {
  it.each([
    [`https://www.facebook.com/watch/?v=${CONTENT_ID}`, "video"],
    [`https://m.facebook.com/reel/${CONTENT_ID}/`, "reel"]
  ])("resolves synthetic HEAD redirect to a canonical %s identity", async (location, sourceKind) => {
    const deps = dependencies([{ statusCode: 302, headerBytes: 128, location }]);
    const resolved = await createFacebookShortLinkResolver(deps)(short());
    expect(resolved.contentId).toBe(CONTENT_ID);
    expect(resolved.sourceKind).toBe(sourceKind);
    expect(resolved.canonicalUrl.hostname).toBe("www.facebook.com");
    expect(deps.requestHead).toHaveBeenCalledTimes(1);
    expect(deps.resolveAddress).toHaveBeenCalledTimes(2);
  });

  it("permits a bounded chain inside exact hosts and strips tracking", async () => {
    const deps = dependencies([
      { statusCode: 301, headerBytes: 128, location: "https://fb.watch/SecondCode/?fbclid=fixture" },
      { statusCode: 302, headerBytes: 128, location: `https://web.facebook.com/watch/?v=${CONTENT_ID}&mibextid=fixture#details` }
    ]);
    const resolved = await createFacebookShortLinkResolver(deps)(short());
    expect(resolved.canonicalUrl.toString()).toBe(`https://www.facebook.com/watch/?v=${CONTENT_ID}`);
    expect(deps.requestHead).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["profile", "https://www.facebook.com/fixture.page/", API_ERROR_CODES.UNSUPPORTED_URL],
    ["group", `https://www.facebook.com/groups/fixture/videos/${CONTENT_ID}/`, API_ERROR_CODES.GROUP_CONTENT_NOT_SUPPORTED],
    ["story", `https://www.facebook.com/stories/fixture/${CONTENT_ID}/`, API_ERROR_CODES.STORY_NOT_SUPPORTED],
    ["live", "https://www.facebook.com/live/", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["login", "https://www.facebook.com/login/", API_ERROR_CODES.LOGIN_REQUIRED],
    ["checkpoint", "https://www.facebook.com/checkpoint/fixture/", API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    ["external", "https://example.com/video", API_ERROR_CODES.UNSUPPORTED_URL],
    ["lookalike", `https://facebook.com.attacker.example/watch/?v=${CONTENT_ID}`, API_ERROR_CODES.UNSUPPORTED_URL],
    ["private IP", `https://127.0.0.1/watch/?v=${CONTENT_ID}`, API_ERROR_CODES.PRIVATE_OR_LOCAL_URL],
    ["loopback IPv6", `https://[::1]/watch/?v=${CONTENT_ID}`, API_ERROR_CODES.PRIVATE_OR_LOCAL_URL]
  ])("rejects a redirect to %s", async (_label, location, code) => {
    const resolver = createFacebookShortLinkResolver(dependencies([
      { statusCode: 302, headerBytes: 128, location }
    ]));
    await expect(resolver(short())).rejects.toMatchObject({ code });
  });

  it("rejects a private resolved address before transport", async () => {
    const deps = dependencies([], {
      resolveAddress: vi.fn(async () => ({ address: "127.0.0.1", family: 4 as const }))
    });
    await expect(createFacebookShortLinkResolver(deps)(short())).rejects.toMatchObject({
      code: API_ERROR_CODES.PRIVATE_OR_LOCAL_URL
    });
    expect(deps.requestHead).not.toHaveBeenCalled();
  });

  it("rejects loops, excessive redirects, and oversized response headers", async () => {
    const loop = createFacebookShortLinkResolver(dependencies([
      { statusCode: 302, headerBytes: 128, location: "https://fb.watch/SecondCode/" },
      { statusCode: 302, headerBytes: 128, location: "https://fb.watch/SynthCode/" }
    ]));
    await expect(loop(short())).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });

    const excessive = createFacebookShortLinkResolver(dependencies([
      { statusCode: 302, headerBytes: 128, location: "https://fb.watch/SecondCode/" },
      { statusCode: 302, headerBytes: 128, location: "https://fb.watch/ThirdCode/" }
    ]), { maxRedirects: 1 });
    await expect(excessive(short())).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });

    const oversized = createFacebookShortLinkResolver(dependencies([
      { statusCode: 302, headerBytes: 16 * 1024 + 1, location: `https://facebook.com/reel/${CONTENT_ID}/` }
    ]));
    await expect(oversized(short())).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
  });

  it("maps unavailable, timeout, and caller abort without leaking inputs", async () => {
    await expectCode(createFacebookShortLinkResolver(dependencies([
      { statusCode: 404, headerBytes: 64 }
    ]))(short()), API_ERROR_CODES.CONTENT_UNAVAILABLE);

    const pending = new Promise<FacebookShortLinkHeadResponse>(() => undefined);
    const timed = createFacebookShortLinkResolver(dependencies([], {
      requestHead: vi.fn(() => pending)
    }), { timeoutMs: 5 });
    await expectCode(timed(short()), API_ERROR_CODES.EXTRACTOR_TIMEOUT);

    const controller = new AbortController();
    const aborted = createFacebookShortLinkResolver(dependencies([], {
      requestHead: vi.fn(() => pending)
    }))(short(), { signal: controller.signal });
    controller.abort();
    await expectCode(aborted, API_ERROR_CODES.JOB_CANCELLED);
  });
});
