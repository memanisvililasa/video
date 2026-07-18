import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { getRedirectTarget, resolveSafeAddress } from "@/lib/http/safe-fetch";
import { API_ERROR_CODES } from "@/lib/types";

const signal = () => new AbortController().signal;
const lookup = (...addresses: string[]) => vi.fn(async () => addresses.map((address) => ({ address, family: 6 })));

async function expectPrivateRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("Expected safe-fetch policy to reject the address.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(API_ERROR_CODES.PRIVATE_OR_LOCAL_URL);
    expect((error as Error).message).not.toMatch(/::ffff|127\.0\.0\.1|10\.0\.0\.1|192\.168\.1\.1/);
  }
}

describe("safe-fetch canonical DNS pinning", () => {
  it.each(["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.1.1"])(
    "rejects a mapped unsafe DNS result: %s",
    async (address) => expectPrivateRejection(resolveSafeAddress("public.example", 1, signal(), lookup(address)))
  );

  it("rejects every mixed answer set containing a mapped private result", async () => {
    await expectPrivateRejection(resolveSafeAddress(
      "public.example",
      1,
      signal(),
      lookup("8.8.8.8", "::ffff:10.0.0.1")
    ));
  });

  it("decodes a mapped public result before pinning", async () => {
    await expect(resolveSafeAddress("public.example", 1, signal(), lookup("::ffff:8.8.8.8")))
      .resolves.toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("revalidates DNS on each request and blocks public-to-mapped-private rebinding", async () => {
    const answers = ["8.8.8.8", "::ffff:127.0.0.1"];
    const resolver = vi.fn(async () => [{ address: answers.shift() as string, family: 6 }]);
    await expect(resolveSafeAddress("public.example", 1, signal(), resolver))
      .resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expectPrivateRejection(resolveSafeAddress("public.example", 1, signal(), resolver));
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("fails closed for malformed or zoned DNS address output", async () => {
    for (const address of ["fe80::1%eth0", "::ffff:999.1.1.1"]) {
      await expect(resolveSafeAddress("public.example", 1, signal(), lookup(address))).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:INVALID_URL|PRIVATE_OR_LOCAL_URL)$/)
      });
    }
  });
});

describe("safe-fetch redirect policy", () => {
  const initial = new URL("https://public.example/media.mp4");

  it("rejects HTTPS downgrade and custom ports for strict platform media", () => {
    expect(() => getRedirectTarget(initial, "http://cdn.example/video.mp4", true)).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.DOWNLOAD_FAILED })
    );
    expect(() => getRedirectTarget(initial, "https://cdn.example:444/video.mp4", true)).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.DOWNLOAD_FAILED })
    );
  });

  it("keeps redirects inside the fixed YouTube media hostname boundary", () => {
    const allowGoogleVideo = (hostname: string) => hostname.endsWith(".googlevideo.com");
    expect(getRedirectTarget(
      new URL("https://r1.googlevideo.com/videoplayback"),
      "https://r2.googlevideo.com/videoplayback",
      true,
      allowGoogleVideo
    ).hostname).toBe("r2.googlevideo.com");
    expect(() => getRedirectTarget(
      new URL("https://r1.googlevideo.com/videoplayback"),
      "https://public.example/videoplayback",
      true,
      allowGoogleVideo
    )).toThrowError(expect.objectContaining({ code: API_ERROR_CODES.DOWNLOAD_FAILED }));
  });

  it.each(["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.1.1"])(
    "rejects a redirect literal to mapped unsafe IPv4: %s",
    (address) => expect(() => getRedirectTarget(initial, `https://[${address}]/fixture.mp4`)).toThrow(AppError)
  );

  it("canonicalizes a redirect literal to mapped public IPv4", () => {
    expect(getRedirectTarget(initial, "https://[::ffff:8.8.8.8]/fixture.mp4").toString())
      .toBe("https://8.8.8.8/fixture.mp4");
  });

  it("rejects a redirect hostname that resolves to mapped private IPv4", async () => {
    const redirect = getRedirectTarget(initial, "https://redirect.example/fixture.mp4");
    await expectPrivateRejection(resolveSafeAddress(redirect.hostname, 1, signal(), lookup("::ffff:10.0.0.1")));
  });

  it("reapplies literal and DNS policy across a redirect chain", async () => {
    const first = getRedirectTarget(initial, "https://first.example/fixture.mp4");
    await expect(resolveSafeAddress(first.hostname, 1, signal(), lookup("::ffff:8.8.8.8")))
      .resolves.toEqual({ address: "8.8.8.8", family: 4 });
    const second = getRedirectTarget(first, "https://second.example/fixture.mp4");
    await expectPrivateRejection(resolveSafeAddress(second.hostname, 1, signal(), lookup("::ffff:127.0.0.1")));
  });
});
