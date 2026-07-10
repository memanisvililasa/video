import type { MediaProbeResult } from "@/lib/ffmpeg/types";

export type { MediaProbeResult } from "@/lib/ffmpeg/types";

export async function probeMedia(_inputPath: string): Promise<MediaProbeResult> {
  throw new Error("FFprobe integration is not implemented yet.");
}
