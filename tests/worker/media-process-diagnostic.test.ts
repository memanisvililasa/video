import { describe, expect, it } from "vitest";
import { MediaProcessError } from "@/lib/ffmpeg/process-runner";
import type { MediaProcessRunner } from "@/lib/ffmpeg/types";
import { createSafeMediaDiagnosticRunner } from "@/tests/helpers/media-process-diagnostic";

describe("worker smoke media diagnostics", () => {
  it("reports only tool, failure category and exit code", async () => {
    const sensitive = "sensitive-runtime-value";
    const base: MediaProcessRunner = async () => {
      throw new MediaProcessError({
        tool: "ffmpeg",
        reason: "non-zero-exit",
        exitCode: 1,
        stderr: sensitive,
        stdout: "/private/runtime/output"
      });
    };
    const diagnostic = createSafeMediaDiagnosticRunner(base);

    await expect(diagnostic.run({
      tool: "ffmpeg",
      args: ["-version"],
      cwd: "/private/runtime",
      timeoutMs: 1_000
    })).rejects.toBeInstanceOf(MediaProcessError);

    expect(diagnostic.failure()).toBe("ffmpeg:non-zero-exit:exit-1");
    expect(diagnostic.failure()).not.toContain(sensitive);
    expect(diagnostic.failure()).not.toContain("/private/runtime");
  });
});
