import {
  MediaProcessError
} from "@/lib/ffmpeg/process-runner";
import type {
  MediaProcessRunner,
  MediaTool
} from "@/lib/ffmpeg/types";

type SafeMediaFailure = Readonly<{
  tool: MediaTool;
  reason: string;
  exitCode: number | null;
}>;

export function createSafeMediaDiagnosticRunner(base: MediaProcessRunner): Readonly<{
  run: MediaProcessRunner;
  failure(): string;
}> {
  let observed: SafeMediaFailure | null = null;
  const run: MediaProcessRunner = async (options) => {
    try {
      return await base(options);
    } catch (error) {
      observed = error instanceof MediaProcessError
        ? Object.freeze({ tool: error.tool, reason: error.reason, exitCode: error.exitCode })
        : Object.freeze({ tool: options.tool, reason: "unexpected", exitCode: null });
      throw error;
    }
  };

  return Object.freeze({
    run,
    failure(): string {
      if (!observed) return "none";
      const exit = observed.exitCode === null ? "none" : String(observed.exitCode);
      return `${observed.tool}:${observed.reason}:exit-${exit}`;
    }
  });
}
