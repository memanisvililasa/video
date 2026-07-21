import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  createTikTokShortLinkResolver,
  type TikTokShortLinkHeadResponse,
  type TikTokShortLinkResolverDependencies
} from "@/lib/extractors/tiktok-short-link";
import { classifyTikTokUrl, type TikTokShortLinkIdentity } from "@/lib/extractors/tiktok-url";
import { API_ERROR_CODES } from "@/lib/types";

const VIDEO_ID = "7000000000000000001";
const PUBLIC_ADDRESS = Object.freeze({ address: "1.1.1.1", family: 4 as const });

function short(value = "https://vm.tiktok.com/SynthCode/"): TikTokShortLinkIdentity {
  const identity = classifyTikTokUrl(new URL(value));
  if (identity.sourceKind !== "short-link") throw new Error("Expected short link.");
  return identity;
}

function dependencies(
  responses: readonly TikTokShortLinkHeadResponse[],
  overrides: Partial<TikTokShortLinkResolverDependencies> = {}
): TikTokShortLinkResolverDependencies {
  let index = 0;
  return {
    resolveAddress: vi.fn(async () => PUBLIC_ADDRESS),
    requestHead: vi.fn(async (request) => {
      expect(request.method).toBe("HEAD");
      return responses[index++] ?? { statusCode: 500 };
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
    expect((error as Error).message).not.toMatch(/https?:\/\/|SynthCode|7000000000000000001/i);
  }
}

describe("controlled TikTok short-link resolver", () => {
  it.each([
    "https://vm.tiktok.com/SynthCode/",
    "https://vt.tiktok.com/SynthCode/",
    "https://www.tiktok.com/t/SynthCode/"
  ])("resolves %s to canonical video identity through synthetic HEAD transport", async (value) => {
    const deps = dependencies([{ statusCode: 302, location: `https://www.tiktok.com/@synthetic/video/${VIDEO_ID}` }]);
    const resolved = await createTikTokShortLinkResolver(deps)(short(value));
    expect(resolved.videoId).toBe(VIDEO_ID);
    expect(resolved.canonicalUrl.toString()).toBe(`https://www.tiktok.com/@_/video/${VIDEO_ID}`);
    expect(deps.requestHead).toHaveBeenCalledTimes(1);
    expect(deps.resolveAddress).toHaveBeenCalledTimes(2);
  });

  it("permits a bounded redirect chain within exact TikTok hosts", async () => {
    const deps = dependencies([
      { statusCode: 301, location: "https://vt.tiktok.com/SecondCode/?_t=tracking" },
      { statusCode: 302, location: `https://www.tiktok.com/@another/video/${VIDEO_ID}?is_copy_url=1#fragment` }
    ]);
    const resolved = await createTikTokShortLinkResolver(deps)(short());
    expect(resolved.canonicalUrl.search).toBe("");
    expect(resolved.canonicalUrl.hash).toBe("");
    expect(deps.requestHead).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["profile", "https://www.tiktok.com/@synthetic", API_ERROR_CODES.UNSUPPORTED_URL],
    ["live", "https://www.tiktok.com/@synthetic/live", API_ERROR_CODES.LIVE_NOT_SUPPORTED],
    ["photo", `https://www.tiktok.com/@synthetic/photo/${VIDEO_ID}`, API_ERROR_CODES.PHOTO_POST_NOT_SUPPORTED],
    ["external", "https://example.com/video", API_ERROR_CODES.UNSUPPORTED_URL],
    ["mobile alias", `https://m.tiktok.com/@synthetic/video/${VIDEO_ID}`, API_ERROR_CODES.UNSUPPORTED_URL],
    ["bare alias", `https://tiktok.com/@synthetic/video/${VIDEO_ID}`, API_ERROR_CODES.UNSUPPORTED_URL],
    ["lookalike", `https://tiktok.com.attacker.example/@synthetic/video/${VIDEO_ID}`, API_ERROR_CODES.UNSUPPORTED_URL]
  ])("rejects a redirect to %s", async (_label, location, code) => {
    const resolver = createTikTokShortLinkResolver(dependencies([{ statusCode: 302, location }]));
    await expect(resolver(short())).rejects.toMatchObject({ code });
  });

  it("rejects a private resolved address before transport", async () => {
    const deps = dependencies([], {
      resolveAddress: vi.fn(async () => ({ address: "127.0.0.1", family: 4 as const }))
    });
    await expect(createTikTokShortLinkResolver(deps)(short())).rejects.toMatchObject({
      code: API_ERROR_CODES.PRIVATE_OR_LOCAL_URL
    });
    expect(deps.requestHead).not.toHaveBeenCalled();
  });

  it("rejects redirect loops and excessive redirect chains", async () => {
    const loop = createTikTokShortLinkResolver(dependencies([
      { statusCode: 302, location: "https://vt.tiktok.com/SecondCode/" },
      { statusCode: 302, location: "https://vm.tiktok.com/SynthCode/" }
    ]));
    await expect(loop(short())).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });

    const excessive = createTikTokShortLinkResolver(dependencies([
      { statusCode: 302, location: "https://vt.tiktok.com/SecondCode/" },
      { statusCode: 302, location: "https://vm.tiktok.com/ThirdCode/" }
    ]), { maxRedirects: 1 });
    await expect(excessive(short())).rejects.toMatchObject({ code: API_ERROR_CODES.EXTRACTOR_FAILED });
  });

  it.each([
    [401, API_ERROR_CODES.LOGIN_REQUIRED],
    [403, API_ERROR_CODES.CAPTCHA_OR_BOT_CHALLENGE],
    [404, API_ERROR_CODES.CONTENT_UNAVAILABLE],
    [410, API_ERROR_CODES.CONTENT_UNAVAILABLE],
    [429, API_ERROR_CODES.RATE_LIMITED],
    [451, API_ERROR_CODES.REGION_RESTRICTED]
  ])("maps short-link HTTP %s safely", async (statusCode, code) => {
    await expect(createTikTokShortLinkResolver(dependencies([{ statusCode }]))(short()))
      .rejects.toMatchObject({ code });
  });

  it("maps timeout and caller abort without leaking URLs", async () => {
    const pending = new Promise<TikTokShortLinkHeadResponse>(() => undefined);
    const timed = createTikTokShortLinkResolver(dependencies([], {
      requestHead: vi.fn(() => pending)
    }), { timeoutMs: 5 });
    await expectCode(timed(short()), API_ERROR_CODES.EXTRACTOR_TIMEOUT);

    const controller = new AbortController();
    const aborted = createTikTokShortLinkResolver(dependencies([], {
      requestHead: vi.fn(() => pending)
    }))(short(), { signal: controller.signal });
    controller.abort();
    await expectCode(aborted, API_ERROR_CODES.JOB_CANCELLED);
  });

  it("does not allow construction to widen the ten-second or three-redirect boundary", () => {
    expect(() => createTikTokShortLinkResolver(dependencies([]), { timeoutMs: 10_001 })).toThrow(TypeError);
    expect(() => createTikTokShortLinkResolver(dependencies([]), { maxRedirects: 4 })).toThrow(TypeError);
  });
});
