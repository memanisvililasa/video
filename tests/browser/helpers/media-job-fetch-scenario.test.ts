import { describe, expect, it, vi } from "vitest";
import {
  deferredResponse,
  type DeferredResponse,
  type ScenarioRequest
} from "@/tests/browser/helpers/media-job-fetch-scenario";

function request(signal: AbortSignal | null = null): ScenarioRequest {
  return Object.freeze({ path: "/fixture", method: "GET", body: null, signal });
}

function invoke(deferred: DeferredResponse, signal: AbortSignal | null = null): Promise<Response> {
  if (typeof deferred.step !== "function") throw new TypeError("Deferred step is not callable.");
  return Promise.resolve(deferred.step(request(signal)));
}

describe("deferred browser response helper", () => {
  it("exposes a resolver immediately and preserves an early resolution for the later fetch step", async () => {
    const deferred = deferredResponse();
    const response = new Response("early", { status: 200 });
    expect(() => deferred.resolve(response)).not.toThrow();
    await expect(invoke(deferred)).resolves.toBe(response);
  });

  it("resolves deterministically after the fetch step starts", async () => {
    const deferred = deferredResponse();
    const pending = invoke(deferred);
    const response = new Response("ready", { status: 200 });
    deferred.resolve(response);
    await expect(pending).resolves.toBe(response);
  });

  it("rejects deterministically and removes its abort listener", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const deferred = deferredResponse({ rejectOnAbort: true });
    const pending = invoke(deferred, controller.signal);
    const error = new Error("fixture rejection");
    deferred.reject(error);
    await expect(pending).rejects.toBe(error);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("keeps the first settlement when resolve is called more than once", async () => {
    const deferred = deferredResponse();
    const first = new Response("first", { status: 200 });
    const second = new Response("second", { status: 200 });
    deferred.resolve(first);
    expect(() => deferred.resolve(second)).not.toThrow();
    await expect(invoke(deferred)).resolves.toBe(first);
  });

  it("cleans up a pending response without timers or an unhandled rejection", async () => {
    const deferred = deferredResponse();
    const pending = invoke(deferred);
    deferred.cleanup();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(() => deferred.cleanup()).not.toThrow();
  });

  it("is one-shot when a scenario accidentally invokes the same deferred step twice", async () => {
    const deferred = deferredResponse();
    const first = invoke(deferred);
    expect(() => invoke(deferred)).toThrow("one-shot");
    deferred.cleanup();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
  });
});
