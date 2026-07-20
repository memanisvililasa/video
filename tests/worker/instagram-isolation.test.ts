import { describe, expect, it, vi } from "vitest";
import type { Extractor } from "@/lib/extractors/types";
import { API_ERROR_CODES } from "@/lib/types";
import {
  createMediaWorkerProcessor,
  type ProcessClaimContext,
  type WorkerProcessorConfig,
  type WorkerProcessorDependencies
} from "@/lib/worker/processor";

const CONFIG: WorkerProcessorConfig = Object.freeze({
  maxFileSizeBytes: 1024,
  maxOutputBytes: 1024,
  maxDurationSeconds: 60,
  metadataTimeoutSeconds: 1,
  downloadTimeoutSeconds: 1,
  ffprobeTimeoutMs: 1_000,
  ffmpegTimeoutMs: 1_000,
  ffmpegThreads: 1,
  finalTtlSeconds: 60
});

describe("Instagram worker isolation", () => {
  it("rejects a durable Instagram source before extractor, storage, or process execution", async () => {
    const extract = vi.fn();
    const download = vi.fn();
    const runProcess = vi.fn();
    const createAttemptWorkspace = vi.fn();
    const extractor: Extractor = {
      id: "instagram",
      name: "Instagram",
      supports: () => true,
      extract,
      download
    };
    const processor = createMediaWorkerProcessor({
      storage: { createAttemptWorkspace } as unknown as WorkerProcessorDependencies["storage"],
      artifacts: {} as WorkerProcessorDependencies["artifacts"],
      runProcess,
      getExtractor: () => extractor
    }, CONFIG);
    const controller = new AbortController();
    const context = {
      claimed: {
        workItem: {
          sourceUrl: "https://www.instagram.com/reel/Synth_01/",
          formatId: "synthetic-format",
          processingPreset: "original"
        }
      },
      session: { signal: controller.signal },
      progress: {}
    } as unknown as ProcessClaimContext;

    await expect(processor.process(context)).rejects.toMatchObject({
      code: API_ERROR_CODES.UNSUPPORTED_URL
    });
    expect(extract).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
    expect(createAttemptWorkspace).not.toHaveBeenCalled();
  });
});
