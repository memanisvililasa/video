import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateDownloadJobData,
  CreateDownloadJobRequest,
  MediaJobApiResult,
  MediaJobApiSnapshot
} from "@/lib/api/media-job-dto";
import {
  createMediaJobPollingController,
  type CancellationRequestState,
  type MediaJobPollingController
} from "@/lib/client/media-job-poller";
import {
  INITIAL_MEDIA_DOWNLOAD_UI_STATE,
  getSafeStatusMessage,
  mediaDownloadUiReducer,
  type MediaDownloadUiEvent,
  type MediaDownloadUiState,
  type MediaSelectionData
} from "@/lib/client/media-job-state";
import { API_ERROR_MESSAGES } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";

const JOB_ID = "job_0123456789abcdef";
const SECOND_JOB_ID = "job_fedcba9876543210";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2026-01-01T01:00:00.000Z";

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function media(): MediaSelectionData {
  return {
    platform: "direct-media",
    title: "Public video",
    duration: "1:30",
    qualities: [{ id: "direct-source", label: "1080P MP4", meta: "видео + аудио · 1920x1080" }]
  };
}

function request(): CreateDownloadJobRequest {
  return {
    url: "https://public.example/video.mp4",
    formatId: "direct-source",
    processingPreset: "original",
    rightsConfirmed: true
  };
}

function createData(jobId = JOB_ID, overrides: Partial<CreateDownloadJobData> = {}): CreateDownloadJobData {
  return {
    jobId,
    status: "queued",
    progress: 0,
    processingPreset: "original",
    createdAt: CREATED_AT,
    expiresAt: null,
    statusUrl: `/api/jobs/${jobId}`,
    cancelUrl: `/api/jobs/${jobId}`,
    ...overrides
  };
}

function result(downloadUrl = "/api/file/file_0123456789abcdef"): MediaJobApiResult {
  return {
    fileId: "file_0123456789abcdef",
    filename: "public-video.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_024,
    downloadUrl,
    expiresAt: EXPIRES_AT,
    processingPreset: "original",
    media: {
      durationSeconds: 90,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac"
    }
  };
}

function snapshot(
  status: MediaJobApiSnapshot["status"],
  options: { jobId?: string; progress?: number; downloadUrl?: string } = {}
): MediaJobApiSnapshot {
  const jobId = options.jobId ?? JOB_ID;
  const common = {
    jobId,
    status,
    progress: options.progress ?? (status === "ready" ? 100 : status === "running" ? 40 : 0),
    processingPreset: "original" as const,
    createdAt: CREATED_AT,
    startedAt: status === "running" || status === "ready" ? "2026-01-01T00:00:01.000Z" : null,
    completedAt: ["ready", "failed", "cancelled"].includes(status) ? "2026-01-01T00:10:00.000Z" : null,
    expiresAt: ["ready", "failed", "cancelled"].includes(status) ? EXPIRES_AT : null
  };
  switch (status) {
    case "ready": return { ...common, status, result: result(options.downloadUrl) };
    case "failed": return {
      ...common,
      status,
      error: { code: API_ERROR_CODES.PROCESSING_FAILED, message: API_ERROR_MESSAGES.PROCESSING_FAILED }
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

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

function success<T>(data: T, status = 200): Response {
  return jsonResponse(status, { ok: true, data });
}

function failure(code: keyof typeof API_ERROR_CODES, status: number, headers?: HeadersInit): Response {
  return jsonResponse(status, {
    ok: false,
    error: { code: API_ERROR_CODES[code], message: API_ERROR_MESSAGES[API_ERROR_CODES[code]] }
  }, headers);
}

function confirmedSelection(): MediaDownloadUiState {
  let state = mediaDownloadUiReducer(INITIAL_MEDIA_DOWNLOAD_UI_STATE, {
    type: "EXTRACT_STARTED",
    requestGeneration: 1
  });
  state = mediaDownloadUiReducer(state, {
    type: "EXTRACT_SUCCEEDED",
    requestGeneration: 1,
    media: media()
  });
  return mediaDownloadUiReducer(state, { type: "RIGHTS_UPDATED", rightsConfirmed: true });
}

type Harness = {
  controller: MediaJobPollingController;
  fetchMock: ReturnType<typeof vi.fn<FetchFunction>>;
  events: MediaDownloadUiEvent[];
  cancellationStates: CancellationRequestState[];
  getState: () => MediaDownloadUiState;
  setState: (state: MediaDownloadUiState) => void;
};

function createHarness(options: { maxDurationMs?: number; maxFailures?: number } = {}): Harness {
  let state = confirmedSelection();
  const events: MediaDownloadUiEvent[] = [];
  const cancellationStates: CancellationRequestState[] = [];
  const fetchMock = vi.fn<FetchFunction>();
  const controller = createMediaJobPollingController({
    dispatch(event) {
      events.push(event);
      state = mediaDownloadUiReducer(state, event);
    },
    getState: () => state,
    fetch: fetchMock,
    onCancellationStateChange(value) {
      cancellationStates.push(value);
    },
    policy: {
      firstPollDelayMs: 100,
      regularPollDelayMs: 100,
      requestTimeoutMs: 500,
      maxPollingDurationMs: options.maxDurationMs ?? 1_000,
      maxConsecutiveFailures: options.maxFailures ?? 3,
      maxRetryAfterMs: 500,
      networkBackoffMs: [100, 200, 300]
    }
  });
  return {
    controller,
    fetchMock,
    events,
    cancellationStates,
    getState: () => state,
    setState(next) { state = next; }
  };
}

async function submit(harness: Harness, data = createData()): Promise<void> {
  harness.fetchMock.mockResolvedValueOnce(success(data, 202));
  await harness.controller.submitJob(request(), 2);
}

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CREATED_AT));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("media job POST and polling", () => {
  it("creates an active job and starts the first canonical poll", async () => {
    const harness = createHarness();
    await submit(harness);
    expect(harness.getState()).toMatchObject({ status: "queued", jobId: JOB_ID });
    expect(harness.controller.getActiveJobId()).toBe(JOB_ID);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);

    harness.fetchMock.mockResolvedValueOnce(success(snapshot("queued")));
    await advance(99);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.fetchMock.mock.calls[1]?.[0]).toBe(`/api/jobs/${JOB_ID}`);
    expect(harness.fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it("sends only the approved POST body and ignores external route fields", async () => {
    const harness = createHarness();
    await submit(harness);
    const [url, init] = harness.fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/download");
    expect(init).toMatchObject({ method: "POST", credentials: "omit" });
    expect(JSON.parse(String(init?.body))).toEqual(request());
    expect(String(init?.body)).not.toContain("outputPath");
    expect(String(init?.body)).not.toContain("jobId");
  });

  it.each([
    ["malformed JSON", new Response("{", { status: 202, headers: { "Content-Type": "application/json" } })],
    ["wrong content type", new Response("{}", { status: 202, headers: { "Content-Type": "text/plain" } })],
    ["external status URL", success(createData(JOB_ID, { statusUrl: "https://attacker.example/job" }), 202)]
  ])("maps a %s POST response to a safe protocol failure", async (_name, response) => {
    const harness = createHarness();
    harness.fetchMock.mockResolvedValueOnce(response);
    await harness.controller.submitJob(request(), 2);
    expect(harness.getState()).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.INTERNAL_ERROR }
    });
    expect(harness.controller.getActiveJobId()).toBeNull();
    expect(JSON.stringify(harness.getState())).not.toContain("attacker.example");
  });

  it("maps a POST ApiFailure using safe reducer output", async () => {
    const harness = createHarness();
    harness.fetchMock.mockResolvedValueOnce(failure("QUEUE_FULL", 503));
    await harness.controller.submitJob(request(), 2);
    expect(harness.getState()).toMatchObject({
      status: "failed",
      error: { code: API_ERROR_CODES.QUEUE_FULL, message: API_ERROR_MESSAGES.QUEUE_FULL }
    });
  });

  it("ignores an intentionally aborted POST", async () => {
    const harness = createHarness();
    let signal: AbortSignal | undefined;
    harness.fetchMock.mockImplementationOnce((_input, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    const pending = harness.controller.submitJob(request(), 2);
    harness.controller.stop();
    expect(signal?.aborted).toBe(true);
    expect(harness.events.some((event) => event.type === "JOB_REQUEST_FAILED")).toBe(false);
    void pending;
  });

  it("polls sequentially without overlapping slow GET requests", async () => {
    const harness = createHarness();
    await submit(harness);
    let resolveGet!: (response: Response) => void;
    harness.fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveGet = resolve; }));
    await advance(100);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    await advance(400);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    resolveGet(success(snapshot("running")));
    await Promise.resolve();
    await advance(99);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("ready")));
    await advance(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("moves queued → running → ready and clears the terminal timer", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock
      .mockResolvedValueOnce(success(snapshot("queued", { progress: 5 })))
      .mockResolvedValueOnce(success(snapshot("running", { progress: 55 })))
      .mockResolvedValueOnce(success(snapshot("ready")));
    await advance(100);
    expect(harness.getState()).toMatchObject({ status: "queued", progress: 5 });
    await advance(100);
    expect(harness.getState()).toMatchObject({ status: "running", progress: 55 });
    await advance(100);
    expect(harness.getState()).toMatchObject({ status: "ready", progress: 100 });
    expect(harness.controller.getActiveJobId()).toBeNull();
    await advance(5_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(["failed", "cancelled", "expired"] as const)("stops on %s", async (status) => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot(status)));
    await advance(100);
    expect(harness.getState().status).toBe(status);
    expect(harness.controller.getActiveJobId()).toBeNull();
    await advance(2_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps active JOB_NOT_FOUND to expired", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock.mockResolvedValueOnce(failure("JOB_NOT_FOUND", 404));
    await advance(100);
    expect(harness.getState()).toMatchObject({
      status: "expired",
      jobId: JOB_ID,
      message: "Задача не найдена или срок хранения файла истёк"
    });
    expect(getSafeStatusMessage(harness.getState())).toBe("Задача не найдена или срок хранения файла истёк");
  });

  it("honours bounded Retry-After for 429", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock
      .mockResolvedValueOnce(failure("RATE_LIMITED", 429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(success(snapshot("ready")));
    await advance(100);
    await advance(499);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
    expect(harness.getState().status).toBe("ready");
  });

  it("retries temporary 500 and network failures with bounded backoff", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock
      .mockResolvedValueOnce(failure("INTERNAL_ERROR", 500))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(success(snapshot("ready")));
    await advance(100);
    await advance(100);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
    await advance(199);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(harness.getState().status).toBe("ready");
  });

  it("stops after the bounded consecutive network failure limit", async () => {
    const harness = createHarness({ maxFailures: 3 });
    await submit(harness);
    harness.fetchMock.mockRejectedValue(new TypeError("offline"));
    await advance(100);
    await advance(100);
    await advance(200);
    expect(harness.getState()).toMatchObject({ status: "network-error", operation: "poll", jobId: JOB_ID });
    expect(getSafeStatusMessage(harness.getState())).toBe("Не удалось получить статус задачи");
    expect(harness.controller.getActiveJobId()).toBeNull();
    await advance(5_000);
    expect(harness.fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stops at the total polling timeout without deleting the server job", async () => {
    const harness = createHarness({ maxDurationMs: 250 });
    await submit(harness);
    harness.fetchMock.mockImplementation(async () => success(snapshot("queued")));
    await advance(100);
    await advance(100);
    await advance(50);
    expect(harness.getState()).toMatchObject({ status: "polling-timeout", jobId: JOB_ID });
    expect(harness.fetchMock.mock.calls.some((call) => call[1]?.method === "DELETE")).toBe(false);
  });

  it("keeps progress monotonic for the same job", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock
      .mockResolvedValueOnce(success(snapshot("running", { progress: 70 })))
      .mockResolvedValueOnce(success(snapshot("running", { progress: 20 })))
      .mockResolvedValueOnce(success(snapshot("ready")));
    await advance(100);
    expect(harness.getState()).toMatchObject({ progress: 70 });
    await advance(100);
    expect(harness.getState()).toMatchObject({ status: "running", progress: 70 });
  });

  it("ignores a snapshot for another jobId and never fetches its advertised route", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock
      .mockResolvedValueOnce(success(snapshot("running", { jobId: SECOND_JOB_ID })))
      .mockResolvedValueOnce(success(snapshot("ready")));
    await advance(100);
    expect(harness.getState()).toMatchObject({ status: "queued", jobId: JOB_ID });
    await advance(100);
    expect(harness.getState().status).toBe("ready");
    for (const call of harness.fetchMock.mock.calls) expect(String(call[0])).not.toContain(SECOND_JOB_ID);
  });

  it("rejects an external ready download URL", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("ready", {
      downloadUrl: "https://attacker.example/output.mp4"
    })));
    await advance(100);
    expect(harness.getState()).toMatchObject({ status: "failed" });
    expect(JSON.stringify(harness.getState())).not.toContain("attacker.example");
  });
});

describe("polling lifecycle cleanup and stale requests", () => {
  it("dispose aborts an in-flight GET and prevents later dispatch", async () => {
    const harness = createHarness();
    await submit(harness);
    let signal: AbortSignal | undefined;
    let resolveGet!: (response: Response) => void;
    harness.fetchMock.mockImplementationOnce((_input, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { resolveGet = resolve; });
    });
    await advance(100);
    const eventCount = harness.events.length;
    harness.controller.dispose();
    expect(signal?.aborted).toBe(true);
    resolveGet(success(snapshot("ready")));
    await Promise.resolve();
    expect(harness.events).toHaveLength(eventCount);
  });

  it("a new job aborts and invalidates the previous in-flight poll", async () => {
    const harness = createHarness();
    await submit(harness);
    let oldSignal: AbortSignal | undefined;
    let resolveOld!: (response: Response) => void;
    harness.fetchMock.mockImplementationOnce((_input, init) => {
      oldSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { resolveOld = resolve; });
    });
    await advance(100);

    harness.setState(confirmedSelection());
    harness.fetchMock.mockResolvedValueOnce(success(createData(SECOND_JOB_ID), 202));
    await harness.controller.submitJob(request(), 3);
    expect(oldSignal?.aborted).toBe(true);
    expect(harness.getState()).toMatchObject({ status: "queued", jobId: SECOND_JOB_ID });
    resolveOld(success(snapshot("ready")));
    await Promise.resolve();
    expect(harness.getState()).toMatchObject({ status: "queued", jobId: SECOND_JOB_ID });
  });

  it("ignores a stale POST after a newer submit", async () => {
    const harness = createHarness();
    let resolveFirst!: (response: Response) => void;
    harness.fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }));
    const first = harness.controller.submitJob(request(), 2);

    harness.controller.stop();
    harness.setState(confirmedSelection());
    harness.fetchMock.mockResolvedValueOnce(success(createData(SECOND_JOB_ID), 202));
    await harness.controller.submitJob(request(), 3);
    resolveFirst(success(createData(), 202));
    await first;
    expect(harness.getState()).toMatchObject({ status: "queued", jobId: SECOND_JOB_ID });
  });

  it("blocks a duplicate submit while POST is in flight", async () => {
    const harness = createHarness();
    let resolvePost!: (response: Response) => void;
    harness.fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    const first = harness.controller.submitJob(request(), 2);
    const second = harness.controller.submitJob(request(), 3);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    resolvePost(success(createData(), 202));
    await Promise.all([first, second]);
    expect(harness.getState()).toMatchObject({ status: "queued", requestGeneration: 2, jobId: JOB_ID });
  });

  it("can resume a timed-out status check explicitly", async () => {
    const harness = createHarness({ maxDurationMs: 150 });
    await submit(harness);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("queued")));
    await advance(150);
    expect(harness.getState().status).toBe("polling-timeout");
    expect(harness.controller.resumePolling()).toBe(true);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("ready")));
    await advance(100);
    expect(harness.getState().status).toBe("ready");
  });
});

describe("media job cancellation", () => {
  it.each(["queued", "running"] as const)("cancels a %s job through one DELETE", async (status) => {
    const harness = createHarness();
    await submit(harness);
    if (status === "running") {
      harness.fetchMock.mockResolvedValueOnce(success(snapshot("running")));
      await advance(100);
    }
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("cancelled")));
    await harness.controller.cancelActiveJob();
    expect(harness.getState()).toMatchObject({ status: "cancelled", jobId: JOB_ID });
    const deleteCalls = harness.fetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.[0]).toBe(`/api/jobs/${JOB_ID}`);
  });

  it("deduplicates a double-click while DELETE is in flight", async () => {
    const harness = createHarness();
    await submit(harness);
    let resolveDelete!: (response: Response) => void;
    harness.fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveDelete = resolve; }));
    const first = harness.controller.cancelActiveJob();
    const second = harness.controller.cancelActiveJob();
    expect(first).toBe(second);
    expect(harness.fetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(1);
    resolveDelete(success(snapshot("cancelled")));
    await first;
    expect(harness.getState().status).toBe("cancelled");
  });

  it.each([
    ["network failure", () => Promise.reject(new TypeError("offline"))],
    ["invalid state", () => Promise.resolve(failure("INVALID_JOB_STATE", 409))]
  ] as const)("does not claim cancellation after %s and resumes polling", async (_name, deleteResult) => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock.mockImplementationOnce(deleteResult);
    await harness.controller.cancelActiveJob();
    expect(harness.getState().status).toBe("queued");
    expect(harness.cancellationStates.at(-1)?.error).toBeTruthy();
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("running")));
    await advance(100);
    expect(harness.getState().status).toBe("running");
  });

  it("does not expose internal details from a cancellation error", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock.mockResolvedValueOnce(jsonResponse(409, {
      ok: false,
      error: {
        code: "INVALID_JOB_STATE",
        message: "ffmpeg stderr at /private/tmp/source.mp4 https://source.example/video"
      }
    }));
    await harness.controller.cancelActiveJob();
    const message = harness.cancellationStates.at(-1)?.error ?? "";
    expect(message).toBe("Не удалось выполнить запрос.");
    expect(message).not.toMatch(/ffmpeg|stderr|\/private\/tmp|https?:\/\//i);
  });

  it("ignores a stale GET ready response after DELETE cancelled", async () => {
    const harness = createHarness();
    await submit(harness);
    let oldSignal: AbortSignal | undefined;
    let resolveGet!: (response: Response) => void;
    harness.fetchMock.mockImplementationOnce((_input, init) => {
      oldSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { resolveGet = resolve; });
    });
    await advance(100);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("cancelled")));
    await harness.controller.cancelActiveJob();
    expect(oldSignal?.aborted).toBe(true);
    resolveGet(success(snapshot("ready")));
    await Promise.resolve();
    expect(harness.getState().status).toBe("cancelled");
  });

  it("accepts ready when completion wins the DELETE race and never returns to running", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("ready")));
    await harness.controller.cancelActiveJob();
    expect(harness.getState().status).toBe("ready");
    const terminal = harness.getState();
    harness.events.push({
      type: "JOB_SNAPSHOT_RECEIVED",
      requestGeneration: 2,
      snapshot: snapshot("running")
    });
    harness.setState(mediaDownloadUiReducer(terminal, harness.events.at(-1)!));
    expect(harness.getState().status).toBe("ready");
  });

  it("does not send DELETE after a GET has already made the job ready", async () => {
    const harness = createHarness();
    await submit(harness);
    harness.fetchMock.mockResolvedValueOnce(success(snapshot("ready")));
    await advance(100);
    expect(harness.getState().status).toBe("ready");
    await harness.controller.cancelActiveJob();
    expect(harness.fetchMock.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(0);
  });

  it("does not leave unhandled rejections during cancellation races", async () => {
    const harness = createHarness();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await submit(harness);
      harness.fetchMock.mockRejectedValueOnce(new TypeError("offline"));
      await harness.controller.cancelActiveJob();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
