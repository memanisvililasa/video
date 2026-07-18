import { env } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import {
  prepareLocalMp4Output,
  prepareLocalWebmOutput,
  type LocalMediaOutput,
  type LocalMediaOutputDirectoryPolicy
} from "@/lib/ffmpeg/local-output";
import {
  MEDIA_PROCESS_OUTPUT_LIMITS,
  MediaProcessError,
  runMediaProcess
} from "@/lib/ffmpeg/process-runner";
import { probeMediaFile, resolveLocalMediaFile, type ProbeMediaFileOptions } from "@/lib/ffmpeg/probe";
import type {
  MediaProbeResult,
  MediaProcessRunner,
  MergeAudioVideoOptions,
  MergeAudioVideoResult
} from "@/lib/ffmpeg/types";
import { normalizeStorageRoot } from "@/lib/storage/path-safety";
import { API_ERROR_CODES } from "@/lib/types";

export type { MergeAudioVideoOptions, MergeAudioVideoResult } from "@/lib/ffmpeg/types";

const ALLOWED_DEMUXERS = "mov,matroska,webm";
const MP4_VIDEO_CODECS = new Set(["h264", "hevc", "av1", "vp9"]);
const MP4_AUDIO_CODECS = new Set(["aac", "mp3", "ac3", "eac3", "alac", "opus"]);
const WEBM_VIDEO_CODECS = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO_CODECS = new Set(["opus", "vorbis"]);

type ProbeMedia = (inputPath: string, options?: ProbeMediaFileOptions) => Promise<MediaProbeResult>;

export type MediaMergeDependencies = {
  runProcess: MediaProcessRunner;
  probeMedia: ProbeMedia;
  getAllowedRoot: () => string;
  timeoutMs: number;
  maxOutputBytes: number;
  outputDirectoryPolicy?: LocalMediaOutputDirectoryPolicy;
};

function mergeFailedError(): AppError {
  return new AppError(API_ERROR_CODES.MERGE_FAILED);
}

function playableVideos(metadata: MediaProbeResult) {
  return metadata.videoStreams.filter((stream) => stream.attachedPicture !== true);
}

function assertInputs(video: MediaProbeResult, audio: MediaProbeResult, container: "mp4" | "webm"): void {
  const videos = playableVideos(video);
  if (videos.length !== 1 || video.audioStreams.length !== 0) throw mergeFailedError();
  if (playableVideos(audio).length !== 0 || audio.audioStreams.length !== 1) throw mergeFailedError();

  const videoCodecs = container === "mp4" ? MP4_VIDEO_CODECS : WEBM_VIDEO_CODECS;
  const audioCodecs = container === "mp4" ? MP4_AUDIO_CODECS : WEBM_AUDIO_CODECS;
  if (!videoCodecs.has(videos[0]?.codec ?? "") || !audioCodecs.has(audio.audioStreams[0]?.codec ?? "")) {
    throw new AppError(API_ERROR_CODES.UNSUPPORTED_CODEC);
  }
}

function buildArguments(
  videoPath: string,
  audioPath: string,
  partialOutputPath: string,
  container: "mp4" | "webm",
  maxOutputBytes: number
): readonly string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
    "-protocol_whitelist", "file", "-format_whitelist", ALLOWED_DEMUXERS, "-i", videoPath,
    "-protocol_whitelist", "file", "-format_whitelist", ALLOWED_DEMUXERS, "-i", audioPath,
    "-map", "0:V:0", "-map", "1:a:0",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-c:v", "copy", "-c:a", "copy", "-sn", "-dn", "-shortest",
    "-fs", String(maxOutputBytes),
    ...(container === "mp4" ? ["-movflags", "+faststart"] : []),
    "-f", container, "-nostats", partialOutputPath
  ];
}

function closeEnough(left: number, right: number, tolerance: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function validateOutput(
  video: MediaProbeResult,
  audio: MediaProbeResult,
  output: MediaProbeResult,
  container: "mp4" | "webm"
): void {
  if (!output.containerFormats.includes(container)) throw mergeFailedError();
  const inputVideo = playableVideos(video)[0];
  const outputVideos = playableVideos(output);
  if (!inputVideo || outputVideos.length !== 1 || output.audioStreams.length !== 1) throw mergeFailedError();
  const outputVideo = outputVideos[0];
  if (
    !outputVideo || outputVideo.codec !== inputVideo.codec || outputVideo.width !== inputVideo.width ||
    outputVideo.height !== inputVideo.height || output.audioStreams[0]?.codec !== audio.audioStreams[0]?.codec
  ) throw mergeFailedError();

  if (inputVideo.frameRate) {
    const actual = outputVideo.frameRate?.value;
    if (!actual || !closeEnough(actual, inputVideo.frameRate.value, Math.max(0.01, inputVideo.frameRate.value * 0.001))) {
      throw mergeFailedError();
    }
  }
  const expectedDuration = Math.min(video.durationSeconds, audio.durationSeconds);
  if (!closeEnough(output.durationSeconds, expectedDuration, Math.max(0.25, expectedDuration * 0.01))) {
    throw mergeFailedError();
  }
}

function mapProcessError(error: MediaProcessError): AppError {
  switch (error.reason) {
    case "spawn": return new AppError(API_ERROR_CODES.FFMPEG_NOT_AVAILABLE);
    case "timeout": return new AppError(API_ERROR_CODES.PROCESSING_TIMEOUT);
    case "aborted": return new AppError(API_ERROR_CODES.JOB_CANCELLED);
    case "stdout-limit":
    case "non-zero-exit": return mergeFailedError();
  }
}

/** @internal Exported for deterministic process/probe injection in tests. */
export function createMediaMerge(dependencies: MediaMergeDependencies) {
  if (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs <= 0) {
    throw new TypeError("Merge timeoutMs must be a positive integer.");
  }
  if (!Number.isSafeInteger(dependencies.maxOutputBytes) || dependencies.maxOutputBytes <= 0) {
    throw new TypeError("Merge maxOutputBytes must be a positive integer.");
  }

  return async function mergeAudioVideo(options: MergeAudioVideoOptions): Promise<MergeAudioVideoResult> {
    let output: LocalMediaOutput | undefined;
    try {
      const [videoFile, audioFile] = await Promise.all([
        resolveLocalMediaFile(options.videoPath, dependencies.getAllowedRoot),
        resolveLocalMediaFile(options.audioPath, dependencies.getAllowedRoot)
      ]);
      if (videoFile.realPath === audioFile.realPath) throw mergeFailedError();

      const prepareOutput = options.container === "mp4" ? prepareLocalMp4Output : prepareLocalWebmOutput;
      output = await prepareOutput(
        options.outputPath,
        videoFile.realPath,
        dependencies.getAllowedRoot,
        dependencies.outputDirectoryPolicy ?? "same-directory"
      );
      const [videoInput, audioInput] = await Promise.all([
        dependencies.probeMedia(videoFile.realPath, { signal: options.signal }),
        dependencies.probeMedia(audioFile.realPath, { signal: options.signal })
      ]);
      assertInputs(videoInput, audioInput, options.container);

      output.markProcessStarted();
      const result = await dependencies.runProcess({
        tool: "ffmpeg",
        args: buildArguments(videoFile.realPath, audioFile.realPath, output.partialPath, options.container, dependencies.maxOutputBytes),
        cwd: output.jobDirectory,
        timeoutMs: dependencies.timeoutMs,
        signal: options.signal,
        stdout: { maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.ffmpegStdoutBytes, overflow: "truncate-tail" },
        stderr: { maxBytes: MEDIA_PROCESS_OUTPUT_LIMITS.stderrBytes, overflow: "truncate-tail" }
      });
      if (result.stdoutTruncated) throw mergeFailedError();

      await output.assertPartialFile(dependencies.maxOutputBytes);
      await output.publish();
      const sizeBytes = await output.assertFinalFile(dependencies.maxOutputBytes);
      const merged = await dependencies.probeMedia(output.finalPath, { signal: options.signal });
      validateOutput(videoInput, audioInput, merged, options.container);
      return { outputPath: output.finalPath, sizeBytes, videoInput, audioInput, output: merged };
    } catch (error) {
      if (output) await output.cleanup();
      if (error instanceof MediaProcessError) throw mapProcessError(error);
      if (error instanceof AppError) throw error;
      throw mergeFailedError();
    }
  };
}

export const mergeAudioVideo = createMediaMerge({
  runProcess: runMediaProcess,
  probeMedia: probeMediaFile,
  getAllowedRoot: () => normalizeStorageRoot(env.storagePath),
  timeoutMs: env.ffmpegTimeoutSeconds * 1000,
  maxOutputBytes: Math.max(1, Math.floor(env.maxFileSizeMb * 1024 * 1024))
});
