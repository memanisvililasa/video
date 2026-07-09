export type MediaProbeResult = {
  durationSeconds?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  formatName?: string;
};

export async function probeMedia(_inputPath: string): Promise<MediaProbeResult> {
  throw new Error("FFprobe integration is not implemented yet.");
}
