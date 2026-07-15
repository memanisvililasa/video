import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Linux deployment validation tooling is intentionally plain Node.js ESM.
import { renderNginxTestConfig, stopChild, withNginxProcess, withUpstreamFixture } from "../../scripts/verify-linux-deployment.mjs";

class FakeHttpServer extends EventEmitter {
  public listening = false;
  public completeClose = true;
  public readonly close = vi.fn((callback: (error?: Error) => void) => {
    if (this.completeClose) {
      this.listening = false;
      callback();
    }
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

class FakeChild extends EventEmitter {
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly signals: NodeJS.Signals[] = [];
  public exitOnSignal = true;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitOnSignal || signal === "SIGKILL") {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("exit", null, signal));
    }
    return true;
  }
}

describe("Linux deployment verifier fixture cleanup", () => {
  it.each(["syntax", "startup", "integration", "timeout"])(
    "closes the upstream fixture when the Nginx %s operation fails",
    async (stage) => {
    const server = new FakeHttpServer();
    const createServer = vi.fn(() => server);

    await expect(withUpstreamFixture(async () => {
      throw new Error(`nginx-${stage}-failed`);
    }, createServer)).rejects.toThrow(`nginx-${stage}-failed`);

    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
    }
  );

  it("bounds upstream cleanup when close never completes", async () => {
    const server = new FakeHttpServer();
    server.completeClose = false;
    await expect(withUpstreamFixture(async () => undefined, () => server, 10))
      .rejects.toThrow("Upstream fixture did not stop");
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("always stops the isolated Nginx child after an assertion failure", async () => {
    const child = new FakeChild();
    await expect(withNginxProcess(child, async () => {
      throw new Error("header-assertion-failed");
    })).rejects.toThrow("header-assertion-failed");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("stops the isolated Nginx child when startup emits an error", async () => {
    const child = new FakeChild();
    const stop = vi.fn(async () => undefined);
    queueMicrotask(() => child.emit("error", new Error("nginx-startup-failed")));
    await expect(withNginxProcess(child, () => new Promise(() => undefined), stop))
      .rejects.toThrow("nginx-startup-failed");
    expect(stop).toHaveBeenCalledWith(child);
  });

  it("escalates bounded Nginx cleanup without leaving a child running", async () => {
    const child = new FakeChild();
    child.exitOnSignal = false;
    await expect(stopChild(child, 10)).rejects.toThrow("Nginx did not stop gracefully");
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("renders isolated access and error logs only under its temporary root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "videosave-nginx-render-"));
    try {
      const rendered = await renderNginxTestConfig(root, {
        upstream: 41001,
        http: 41002,
        https: 41003
      }, {
        certificate: path.join(root, "test.crt"),
        key: path.join(root, "test.key")
      });
      expect(rendered.content).not.toContain("/var/log/nginx");
      expect(rendered.content).toContain(`access_log \"${path.join(root, "logs")}`);
      expect(rendered.content).toContain(`error_log \"${path.join(root, "logs")}`);
      expect(rendered.content).toContain('location ~ "^/api/file/[A-Za-z0-9_-]{8,128}$" {');
      expect(rendered.content).toContain("server 127.0.0.1:41001;");
      await expect(access(rendered.logs)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await expect(access(root)).rejects.toThrow();
    }
  });
});
