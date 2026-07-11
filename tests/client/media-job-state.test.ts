import { describe, expect, it } from "vitest";
import type {
  CreateDownloadJobData,
  MediaJobApiResult,
  MediaJobApiSnapshot,
  ProcessingPreset
} from "@/lib/api/media-job-dto";
import { PROCESSING_PRESETS } from "@/lib/api/media-job-dto";
import {
  USER_PROCESSING_PRESETS,
  isUserProcessingPreset,
  type UserProcessingPreset
} from "@/lib/client/media-preset-options";
import {
  INITIAL_MEDIA_DOWNLOAD_UI_STATE,
  canCancelJob,
  canDownloadFile,
  canSubmitJob,
  getSafeStatusMessage,
  getVisibleProgress,
  isJobActive,
  isTerminalState,
  mapApiSnapshotToUiState,
  mediaDownloadUiReducer,
  type MediaDownloadUiEvent,
  type MediaDownloadUiState,
  type MediaSelectionData
} from "@/lib/client/media-job-state";
import { API_ERROR_CODES } from "@/lib/types";

const JOB_ID = "job_0123456789abcdef";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2026-01-01T01:00:00.000Z";

function media(): MediaSelectionData {
  return {
    platform: "direct-media",
    title: "Public video",
    duration: "1:30",
    qualities: [
      { id: "direct-source", label: "1080P MP4", meta: "видео + аудио · 1920x1080" },
      { id: "audio-source", label: "M4A", meta: "аудио" }
    ]
  };
}

function result(processingPreset: ProcessingPreset = "original"): MediaJobApiResult {
  return {
    fileId: "file_0123456789abcdef",
    filename: processingPreset === "audio-only" ? "public-video.m4a" : "public-video.mp4",
    mimeType: processingPreset === "audio-only" ? "audio/mp4" : "video/mp4",
    sizeBytes: 1_024,
    downloadUrl: "/api/file/file_0123456789abcdef",
    expiresAt: EXPIRES_AT,
    processingPreset,
    media: {
      durationSeconds: 90,
      formatName: processingPreset === "audio-only" ? "mov,mp4,m4a,3gp,3g2,mj2" : "mov,mp4,m4a,3gp,3g2,mj2",
      hasVideo: processingPreset !== "audio-only",
      hasAudio: true,
      ...(processingPreset !== "audio-only" ? { width: 1920, height: 1080, videoCodec: "h264" } : {}),
      audioCodec: "aac"
    }
  };
}

function createData(processingPreset: ProcessingPreset = "original"): CreateDownloadJobData {
  return {
    jobId: JOB_ID,
    status: "queued",
    progress: 0,
    processingPreset,
    createdAt: CREATED_AT,
    expiresAt: null,
    statusUrl: `/api/jobs/${JOB_ID}`,
    cancelUrl: `/api/jobs/${JOB_ID}`
  };
}

function snapshot(
  status: MediaJobApiSnapshot["status"],
  options: { progress?: number; jobId?: string; processingPreset?: ProcessingPreset } = {}
): MediaJobApiSnapshot {
  const processingPreset = options.processingPreset ?? "original";
  const common = {
    jobId: options.jobId ?? JOB_ID,
    status,
    progress: options.progress ?? (status === "ready" ? 100 : status === "running" ? 45 : 0),
    processingPreset,
    createdAt: CREATED_AT,
    startedAt: status === "running" || status === "ready" ? "2026-01-01T00:00:01.000Z" : null,
    completedAt: ["ready", "failed", "cancelled"].includes(status) ? "2026-01-01T00:10:00.000Z" : null,
    expiresAt: ["ready", "failed", "cancelled"].includes(status) ? EXPIRES_AT : null
  };
  switch (status) {
    case "ready": return { ...common, status, result: result(processingPreset) };
    case "failed": return {
      ...common,
      status,
      error: { code: API_ERROR_CODES.PROCESSING_FAILED, message: "Не удалось обработать медиафайл." }
    };
    case "queued":
    case "running":
    case "cancelled":
    case "expired":
      return { ...common, status };
    default: {
      const exhaustive: never = status;
      throw new TypeError(String(exhaustive));
    }
  }
}

function extracting(generation = 1): MediaDownloadUiState {
  return mediaDownloadUiReducer(INITIAL_MEDIA_DOWNLOAD_UI_STATE, {
    type: "EXTRACT_STARTED",
    requestGeneration: generation
  });
}

function selectionReady(generation = 1): MediaDownloadUiState {
  return mediaDownloadUiReducer(extracting(generation), {
    type: "EXTRACT_SUCCEEDED",
    requestGeneration: generation,
    media: media()
  });
}

function confirmedSelection(generation = 1, preset: UserProcessingPreset = "original"): MediaDownloadUiState {
  let state = selectionReady(generation);
  state = mediaDownloadUiReducer(state, { type: "SELECTION_UPDATED", processingPreset: preset });
  return mediaDownloadUiReducer(state, { type: "RIGHTS_UPDATED", rightsConfirmed: true });
}

function submitting(generation = 2, preset: UserProcessingPreset = "original"): MediaDownloadUiState {
  return mediaDownloadUiReducer(confirmedSelection(generation - 1, preset), {
    type: "JOB_SUBMIT_STARTED",
    requestGeneration: generation
  });
}

function queued(generation = 2, preset: UserProcessingPreset = "original"): MediaDownloadUiState {
  return mediaDownloadUiReducer(submitting(generation, preset), {
    type: "JOB_CREATED",
    requestGeneration: generation,
    data: createData(preset)
  });
}

function running(generation = 2): MediaDownloadUiState {
  return mediaDownloadUiReducer(queued(generation), {
    type: "JOB_SNAPSHOT_RECEIVED",
    requestGeneration: generation,
    snapshot: snapshot("running")
  });
}

function ready(generation = 2): MediaDownloadUiState {
  return mediaDownloadUiReducer(running(generation), {
    type: "JOB_SNAPSHOT_RECEIVED",
    requestGeneration: generation,
    snapshot: snapshot("ready")
  });
}

describe("media download UI reducer transitions", () => {
  it("moves idle → extracting → selection-ready", () => {
    const extract = extracting();
    expect(extract).toEqual({ status: "extracting", requestGeneration: 1 });
    const selection = mediaDownloadUiReducer(extract, {
      type: "EXTRACT_SUCCEEDED",
      requestGeneration: 1,
      media: media()
    });
    expect(selection).toMatchObject({
      status: "selection-ready",
      selection: {
        selectedFormatId: "direct-source",
        processingPreset: "original",
        rightsConfirmed: false
      }
    });
  });

  it("moves selection-ready → submitting → queued → running → ready", () => {
    const submit = submitting();
    expect(submit.status).toBe("submitting");
    const queue = mediaDownloadUiReducer(submit, {
      type: "JOB_CREATED",
      requestGeneration: 2,
      data: createData()
    });
    expect(queue).toMatchObject({ status: "queued", jobId: JOB_ID, progress: 0 });
    const run = mediaDownloadUiReducer(queue, {
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 2,
      snapshot: snapshot("running")
    });
    expect(run).toMatchObject({ status: "running", progress: 45 });
    const completed = mediaDownloadUiReducer(run, {
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 2,
      snapshot: snapshot("ready")
    });
    expect(completed).toMatchObject({
      status: "ready",
      progress: 100,
      result: { downloadUrl: "/api/file/file_0123456789abcdef" }
    });
  });

  it("maps running to failed with only a safe API error", () => {
    const failed = mediaDownloadUiReducer(running(), {
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 2,
      snapshot: snapshot("failed")
    });
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.PROCESSING_FAILED, message: "Не удалось обработать медиафайл." }
    });
  });

  it.each(["queued", "running"] as const)("maps %s to cancelled", (source) => {
    const state = source === "queued" ? queued() : running();
    const cancelled = mediaDownloadUiReducer(state, {
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 2,
      snapshot: snapshot("cancelled")
    });
    expect(cancelled).toMatchObject({ status: "cancelled", jobId: JOB_ID });
    expect(cancelled).not.toHaveProperty("result");
  });

  it.each(["queued", "running"] as const)("maps active %s to expired", (source) => {
    const state = source === "queued" ? queued() : running();
    const expired = mediaDownloadUiReducer(state, {
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 2,
      snapshot: snapshot("expired")
    });
    expect(expired).toMatchObject({
      status: "expired",
      jobId: JOB_ID,
      message: "Срок хранения файла истёк"
    });
  });

  it.each(["queued", "running"] as const)("maps active %s to polling-timeout", (source) => {
    const state = source === "queued" ? queued() : running();
    const timedOut = mediaDownloadUiReducer(state, {
      type: "POLLING_TIMED_OUT",
      requestGeneration: 2,
      jobId: JOB_ID
    });
    expect(timedOut).toMatchObject({ status: "polling-timeout", jobId: JOB_ID });
  });

  it("moves ready → downloading → success only after explicit events", () => {
    const prepared = ready();
    const downloading = mediaDownloadUiReducer(prepared, { type: "DOWNLOAD_STARTED", jobId: JOB_ID });
    expect(downloading.status).toBe("downloading");
    const success = mediaDownloadUiReducer(downloading, { type: "DOWNLOAD_TRIGGERED", jobId: JOB_ID });
    expect(success.status).toBe("success");
  });

  it("returns downloading to ready after a client-side download failure", () => {
    const downloading = mediaDownloadUiReducer(ready(), { type: "DOWNLOAD_STARTED", jobId: JOB_ID });
    expect(mediaDownloadUiReducer(downloading, { type: "DOWNLOAD_FAILED", jobId: JOB_ID }).status).toBe("ready");
  });

  it.each(["ready", "success", "failed", "cancelled", "expired", "network-error", "polling-timeout"] as const)(
    "allows terminal %s to start a new job",
    (status) => {
      let state: MediaDownloadUiState;
      if (status === "ready") state = ready();
      else if (status === "success") {
        const downloading = mediaDownloadUiReducer(ready(), { type: "DOWNLOAD_STARTED", jobId: JOB_ID });
        state = mediaDownloadUiReducer(downloading, { type: "DOWNLOAD_TRIGGERED", jobId: JOB_ID });
      } else if (status === "failed") {
        state = mediaDownloadUiReducer(running(), {
          type: "JOB_SNAPSHOT_RECEIVED",
          requestGeneration: 2,
          snapshot: snapshot("failed")
        });
      } else if (status === "cancelled") {
        state = mediaDownloadUiReducer(queued(), {
          type: "JOB_CANCELLED",
          requestGeneration: 2,
          jobId: JOB_ID
        });
      } else if (status === "expired") {
        state = mediaDownloadUiReducer(queued(), {
          type: "JOB_SNAPSHOT_RECEIVED",
          requestGeneration: 2,
          snapshot: snapshot("expired")
        });
      } else if (status === "network-error") {
        state = mediaDownloadUiReducer(submitting(), {
          type: "JOB_REQUEST_FAILED",
          requestGeneration: 2,
          operation: "submit",
          network: true
        });
      } else {
        state = mediaDownloadUiReducer(queued(), {
          type: "POLLING_TIMED_OUT",
          requestGeneration: 2,
          jobId: JOB_ID
        });
      }
      expect(mediaDownloadUiReducer(state, { type: "START_NEW_JOB", requestGeneration: 3 })).toEqual({
        status: "idle",
        requestGeneration: 3
      });
    }
  );

  it("START_NEW_JOB removes the previous preset, rights confirmation and result", () => {
    const completed = ready();
    expect(completed).toMatchObject({
      status: "ready",
      selection: { processingPreset: "original", rightsConfirmed: true },
      result: { filename: "public-video.mp4" }
    });
    const reset = mediaDownloadUiReducer(completed, { type: "START_NEW_JOB", requestGeneration: 3 });
    expect(reset).toEqual({ status: "idle", requestGeneration: 3 });
    expect(reset).not.toHaveProperty("selection");
    expect(reset).not.toHaveProperty("result");
  });
});

describe("forbidden transitions and stale response protection", () => {
  it.each([
    ["ready → running", ready(), { type: "JOB_SNAPSHOT_RECEIVED", requestGeneration: 2, snapshot: snapshot("running") }],
    ["success → queued", mediaDownloadUiReducer(mediaDownloadUiReducer(ready(), { type: "DOWNLOAD_STARTED", jobId: JOB_ID }), { type: "DOWNLOAD_TRIGGERED", jobId: JOB_ID }), { type: "JOB_SNAPSHOT_RECEIVED", requestGeneration: 2, snapshot: snapshot("queued") }],
    ["failed → ready", mediaDownloadUiReducer(running(), { type: "JOB_SNAPSHOT_RECEIVED", requestGeneration: 2, snapshot: snapshot("failed") }), { type: "JOB_SNAPSHOT_RECEIVED", requestGeneration: 2, snapshot: snapshot("ready") }],
    ["cancelled → running", mediaDownloadUiReducer(queued(), { type: "JOB_CANCELLED", requestGeneration: 2, jobId: JOB_ID }), { type: "JOB_SNAPSHOT_RECEIVED", requestGeneration: 2, snapshot: snapshot("running") }],
    ["expired → ready", mediaDownloadUiReducer(queued(), { type: "JOB_SNAPSHOT_RECEIVED", requestGeneration: 2, snapshot: snapshot("expired") }), { type: "JOB_SNAPSHOT_RECEIVED", requestGeneration: 2, snapshot: snapshot("ready") }],
    ["running → selection-ready", running(), { type: "EXTRACT_SUCCEEDED", requestGeneration: 2, media: media() }]
  ] as Array<[string, MediaDownloadUiState, MediaDownloadUiEvent]>)("ignores %s", (_name, state, event) => {
    expect(mediaDownloadUiReducer(state, event)).toBe(state);
  });

  it("ignores a snapshot for another jobId", () => {
    const state = running();
    const next = mediaDownloadUiReducer(state, {
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 2,
      snapshot: snapshot("ready", { jobId: "job_other" })
    });
    expect(next).toBe(state);
  });

  it("ignores stale extract and job generations", () => {
    const first = extracting(1);
    const reset = mediaDownloadUiReducer(first, { type: "RESET", requestGeneration: 2 });
    const second = mediaDownloadUiReducer(reset, { type: "EXTRACT_STARTED", requestGeneration: 3 });
    expect(mediaDownloadUiReducer(second, {
      type: "EXTRACT_SUCCEEDED",
      requestGeneration: 1,
      media: media()
    })).toBe(second);

    const active = running();
    expect(mediaDownloadUiReducer(active, {
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 1,
      snapshot: snapshot("ready")
    })).toBe(active);
  });

  it("rejects unknown events at compile time and runtime", () => {
    expect(() => mediaDownloadUiReducer(INITIAL_MEDIA_DOWNLOAD_UI_STATE, {
      // @ts-expect-error unknown events are not part of MediaDownloadUiEvent
      type: "UNKNOWN_EVENT"
    })).toThrow(TypeError);
  });

  it("rejects arbitrary and hidden preset strings at the reducer boundary", () => {
    const state = selectionReady();
    for (const processingPreset of ["enhance-4k", "remux-to-mp4"]) {
      const next = mediaDownloadUiReducer(state, {
        type: "SELECTION_UPDATED",
        processingPreset
      } as unknown as MediaDownloadUiEvent);
      expect(next).toBe(state);
    }
  });
});

describe("snapshot mapping and sanitization", () => {
  it("maps queued and running snapshots without using injected result fields", () => {
    const state = queued();
    const hostile = {
      ...snapshot("running"),
      result: result(),
      sourceUrl: "https://secret.example/source.mp4",
      path: "/private/tmp/source.mp4",
      stderr: "secret stderr"
    } as unknown as MediaJobApiSnapshot;
    const mapped = mapApiSnapshotToUiState(state, hostile);
    expect(mapped.status).toBe("running");
    expect(mapped).not.toHaveProperty("result");
    const output = JSON.stringify(mapped);
    for (const secret of ["secret.example", "/private/", "stderr"]) expect(output).not.toContain(secret);
  });

  it("turns ready without result into a safe protocol failure", () => {
    const malformed = { ...snapshot("ready"), result: undefined } as unknown as MediaJobApiSnapshot;
    const mapped = mapApiSnapshotToUiState(running(), malformed);
    expect(mapped).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.INTERNAL_ERROR, message: "Получен некорректный ответ сервера." }
    });
  });

  it("turns failed without error into a safe fallback", () => {
    const malformed = { ...snapshot("failed"), error: undefined } as unknown as MediaJobApiSnapshot;
    const mapped = mapApiSnapshotToUiState(running(), malformed);
    expect(mapped).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.INTERNAL_ERROR, message: "Не удалось обработать задачу." }
    });
  });

  it("keeps AUDIO_STREAM_NOT_FOUND as a safe user-facing failure", () => {
    const audioState = queued(2, "audio-only");
    const failedSnapshot = {
      ...snapshot("failed", { processingPreset: "audio-only" }),
      error: {
        code: API_ERROR_CODES.AUDIO_STREAM_NOT_FOUND,
        message: "В медиафайле не найдена аудиодорожка."
      }
    } as MediaJobApiSnapshot;
    const failed = mapApiSnapshotToUiState(audioState, failedSnapshot);
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: API_ERROR_CODES.AUDIO_STREAM_NOT_FOUND,
        message: "В медиафайле не найдена аудиодорожка."
      }
    });
  });

  it("rejects an external ready download URL", () => {
    const malformed = {
      ...snapshot("ready"),
      result: { ...result(), downloadUrl: "https://attacker.example/output.mp4" }
    } as unknown as MediaJobApiSnapshot;
    const mapped = mapApiSnapshotToUiState(running(), malformed);
    expect(mapped.status).toBe("failed");
    expect(JSON.stringify(mapped)).not.toContain("attacker.example");
  });

  it.each([
    [-20, 0],
    [140, 100],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [55.5, 55.5]
  ])("normalizes progress %s to %s", (progress, expected) => {
    const mapped = mapApiSnapshotToUiState(queued(), snapshot("running", { progress }));
    expect(getVisibleProgress(mapped)).toBe(expected);
  });

  it("does not keep source URL, path, stderr, stack or arbitrary internal fields", () => {
    const hostileMedia = {
      ...media(),
      sourceUrl: "https://secret.example/source",
      path: "/private/source.mp4",
      stderr: "stderr secret",
      stack: "stack secret"
    } as unknown as MediaSelectionData;
    const state = mediaDownloadUiReducer(extracting(), {
      type: "EXTRACT_SUCCEEDED",
      requestGeneration: 1,
      media: hostileMedia
    });
    const output = JSON.stringify(state);
    for (const secret of ["secret.example", "/private/", "stderr secret", "stack secret", "sourceUrl"]) {
      expect(output).not.toContain(secret);
    }
  });

  it("rejects path-shaped presentation metadata instead of retaining it", () => {
    const hostile = { ...media(), title: "/private/tmp/source.mp4" };
    const state = mediaDownloadUiReducer(extracting(), {
      type: "EXTRACT_SUCCEEDED",
      requestGeneration: 1,
      media: hostile
    });
    expect(state.status).toBe("failed");
    expect(JSON.stringify(state)).not.toContain("/private/");
  });

  it("maps null metadata and snapshots to safe protocol failures", () => {
    const malformedExtract = mediaDownloadUiReducer(extracting(), {
      type: "EXTRACT_SUCCEEDED",
      requestGeneration: 1,
      media: null as unknown as MediaSelectionData
    });
    expect(malformedExtract).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.INTERNAL_ERROR }
    });

    const malformedSnapshot = mapApiSnapshotToUiState(
      queued(),
      null as unknown as MediaJobApiSnapshot
    );
    expect(malformedSnapshot).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.INTERNAL_ERROR }
    });
  });
});

describe("derived selectors", () => {
  it("requires rights, a known format and supported preset to submit", () => {
    const unconfirmed = selectionReady();
    expect(canSubmitJob(unconfirmed)).toBe(false);
    expect(canSubmitJob(confirmedSelection())).toBe(true);

    const invalidFormat = {
      ...confirmedSelection(),
      selection: { ...(confirmedSelection() as Extract<MediaDownloadUiState, { status: "selection-ready" }>).selection, selectedFormatId: "../../secret" }
    } as MediaDownloadUiState;
    expect(canSubmitJob(invalidFormat)).toBe(false);

    const invalidPreset = {
      ...confirmedSelection(),
      selection: { ...(confirmedSelection() as Extract<MediaDownloadUiState, { status: "selection-ready" }>).selection, processingPreset: "enhance-4k" }
    } as unknown as MediaDownloadUiState;
    expect(canSubmitJob(invalidPreset)).toBe(false);
  });

  it.each(USER_PROCESSING_PRESETS)("supports the user-facing %s preset", (processingPreset) => {
    expect(canSubmitJob(confirmedSelection(1, processingPreset))).toBe(true);
  });

  it("keeps remux-to-mp4 as an API preset while rejecting it from the main UI", () => {
    expect(PROCESSING_PRESETS).toContain("remux-to-mp4");
    expect(isUserProcessingPreset("remux-to-mp4")).toBe(false);
    const injected = {
      ...confirmedSelection(),
      selection: {
        ...(confirmedSelection() as Extract<MediaDownloadUiState, { status: "selection-ready" }>).selection,
        processingPreset: "remux-to-mp4"
      }
    } as unknown as MediaDownloadUiState;
    expect(canSubmitJob(injected)).toBe(false);
  });

  it("blocks repeated submit for submitting, queued and running", () => {
    for (const state of [submitting(), queued(), running()]) {
      expect(canSubmitJob(state)).toBe(false);
      expect(isJobActive(state)).toBe(true);
    }
  });

  it.each(["submitting", "queued", "running"] as const)("blocks preset changes while %s", (status) => {
    const state = status === "submitting" ? submitting() : status === "queued" ? queued() : running();
    const next = mediaDownloadUiReducer(state, {
      type: "SELECTION_UPDATED",
      processingPreset: "audio-only"
    });
    expect(next).toBe(state);
    if (next.status !== "submitting" && next.status !== "queued" && next.status !== "running") {
      throw new Error("Expected an active job state.");
    }
    expect(next.selection.processingPreset).toBe("original");
  });

  it("allows cancellation only for queued and running", () => {
    expect(canCancelJob(queued())).toBe(true);
    expect(canCancelJob(running())).toBe(true);
    for (const state of [selectionReady(), submitting(), ready()]) expect(canCancelJob(state)).toBe(false);
  });

  it("allows file download only for a valid ready result", () => {
    expect(canDownloadFile(ready())).toBe(true);
    expect(canDownloadFile(running())).toBe(false);
    const unsafe = {
      ...ready(),
      result: { ...result(), downloadUrl: "https://attacker.example/output" }
    } as MediaDownloadUiState;
    expect(canDownloadFile(unsafe)).toBe(false);

    const missingCanonicalUrl = {
      ...ready(),
      result: { ...result(), downloadUrl: "" }
    } as MediaDownloadUiState;
    expect(canDownloadFile(missingCanonicalUrl)).toBe(false);
  });

  it("classifies terminal states and returns safe messages exhaustively", () => {
    const states = [
      INITIAL_MEDIA_DOWNLOAD_UI_STATE,
      extracting(),
      selectionReady(),
      submitting(),
      queued(),
      running(),
      ready()
    ];
    for (const state of states) expect(getSafeStatusMessage(state).length).toBeGreaterThan(0);
    expect(isTerminalState(ready())).toBe(true);
    expect(isTerminalState(running())).toBe(false);
  });
});

describe("reducer immutability", () => {
  it("returns frozen copies without mutating previous states or event payloads", () => {
    const initialMedia = media();
    const extract = extracting();
    const next = mediaDownloadUiReducer(extract, {
      type: "EXTRACT_SUCCEEDED",
      requestGeneration: 1,
      media: initialMedia
    });
    expect(extract).toEqual({ status: "extracting", requestGeneration: 1 });
    expect(initialMedia.qualities).toHaveLength(2);
    expect(Object.isFrozen(next)).toBe(true);
    if (next.status !== "selection-ready") throw new Error("Expected selection state.");
    expect(Object.isFrozen(next.selection)).toBe(true);
    expect(Object.isFrozen(next.selection.media)).toBe(true);
    expect(Object.isFrozen(next.selection.media.qualities)).toBe(true);
    expect(next.selection.media).not.toBe(initialMedia);
  });
});
