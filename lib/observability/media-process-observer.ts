import "server-only";
import type { MediaProcessRunner } from "@/lib/ffmpeg/types";
import type { OperationalSignals } from "@/lib/observability/signals";
import { safeSignalMetric } from "@/lib/observability/signals";

export function observeMediaProcessRunner(
  runProcess: MediaProcessRunner,
  signals: OperationalSignals
): MediaProcessRunner {
  return async (options) => {
    const ffmpeg = options.tool === "ffmpeg";
    if (ffmpeg) safeSignalMetric(() => signals.metrics.mediaProcessStarted());
    try {
      return await runProcess(options);
    } finally {
      if (ffmpeg) safeSignalMetric(() => signals.metrics.mediaProcessFinished());
    }
  };
}
