import { describe, expect, it, vi } from "vitest";
import { runMediaWorkerMain } from "@/lib/worker/main";

describe("worker main boundary", () => {
  it("has no import-time execution and rejects unsupported arguments before construction", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMediaWorkerMain(["--unknown"], {})).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("Media worker startup failed: unsupported arguments.");
    error.mockRestore();
  });
});
