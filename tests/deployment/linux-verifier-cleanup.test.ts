import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Linux deployment validation tooling is intentionally plain Node.js ESM.
import { withUpstreamFixture } from "../../scripts/verify-linux-deployment.mjs";

class FakeHttpServer extends EventEmitter {
  public listening = false;
  public readonly close = vi.fn((callback: (error?: Error) => void) => {
    this.listening = false;
    callback();
  });
  public readonly closeAllConnections = vi.fn();

  listen(_port: number, _host: string, callback: () => void): this {
    this.listening = true;
    callback();
    return this;
  }

  address(): { port: number } {
    return { port: 43123 };
  }
}

describe("Linux deployment verifier fixture cleanup", () => {
  it("closes the upstream fixture when the Nginx syntax operation fails", async () => {
    const server = new FakeHttpServer();
    const createServer = vi.fn(() => server);

    await expect(withUpstreamFixture(async () => {
      throw new Error("nginx-syntax-failed");
    }, createServer)).rejects.toThrow("nginx-syntax-failed");

    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });
});
