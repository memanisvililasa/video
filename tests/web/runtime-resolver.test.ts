import { describe, expect, it, vi } from "vitest";
import type { WebApiRuntime } from "@/lib/web/runtime-resolver";
import { createRoleAwareWebRuntimeResolver } from "@/lib/web/runtime-resolver";

function fakeRuntime(role: "local" | "web"): WebApiRuntime {
  return {
    role,
    authority: role === "web" ? "postgres" : "memory",
    jobs: {
      enqueueDownloadJob: vi.fn() as never,
      getDownloadJob: vi.fn() as never,
      cancelDownloadJob: vi.fn() as never
    },
    files: { get: vi.fn() },
    close: vi.fn()
  };
}

describe("role-aware web runtime resolver", () => {
  it("serializes concurrent first web requests into one persistent runtime", async () => {
    const local = vi.fn(async () => fakeRuntime("local"));
    const web = vi.fn(async () => fakeRuntime("web"));
    const resolver = createRoleAwareWebRuntimeResolver({
      source: () => ({ APP_PROCESS_ROLE: "web", NODE_ENV: "test" }),
      createLocal: local,
      createWeb: web
    });
    const [first, second, third] = await Promise.all([
      resolver.resolve(),
      resolver.resolve(),
      resolver.resolve()
    ]);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toMatchObject({ role: "web", authority: "postgres" });
    expect(web).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
    await resolver.close();
  });

  it("preserves a failed web initialization and never falls back to local", async () => {
    const failure = new Error("database unavailable");
    const local = vi.fn(async () => fakeRuntime("local"));
    const web = vi.fn(async () => { throw failure; });
    const resolver = createRoleAwareWebRuntimeResolver({
      source: () => ({ APP_PROCESS_ROLE: "web", NODE_ENV: "test" }),
      createLocal: local,
      createWeb: web
    });
    await expect(resolver.resolve()).rejects.toBe(failure);
    await expect(resolver.resolve()).rejects.toBe(failure);
    expect(web).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
  });

  it.each(["worker", "migration"])("fails closed when %s tries to serve routes", async (role) => {
    const resolver = createRoleAwareWebRuntimeResolver({
      source: () => ({ APP_PROCESS_ROLE: role, NODE_ENV: "test" })
    });
    await expect(resolver.resolve()).rejects.toThrow("cannot serve HTTP routes");
  });

  it("does not invoke either factory while only constructing the resolver", () => {
    const local = vi.fn(async () => fakeRuntime("local"));
    const web = vi.fn(async () => fakeRuntime("web"));
    createRoleAwareWebRuntimeResolver({
      source: () => ({ NODE_ENV: "production" }),
      createLocal: local,
      createWeb: web
    });
    expect(local).not.toHaveBeenCalled();
    expect(web).not.toHaveBeenCalled();
  });
});
