import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render, type RenderResult } from "vitest-browser-react";
import { VideoDownloader } from "@/components/video-downloader";
import { API_ERROR_CODES } from "@/lib/types";
import {
  FAST_POLLING_POLICY,
  JOB_ID,
  MediaJobFetchScenario,
  PUBLIC_PAGE_URL,
  VIDEO_METADATA,
  createJobData,
  deferredResponse,
  failure,
  jobSnapshot,
  success
} from "@/tests/browser/helpers/media-job-fetch-scenario";

const RIGHTS_LABEL = "Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.";

async function extractVideo(screen: RenderResult): Promise<void> {
  await userEvent.fill(screen.getByLabelText("Ссылка на видео"), PUBLIC_PAGE_URL);
  await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
  await expect.element(screen.getByText(VIDEO_METADATA.title)).toBeVisible();
}

async function submitOriginal(screen: RenderResult): Promise<void> {
  await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
  await userEvent.click(screen.getByRole("button", { name: "Подготовить оригинал" }));
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VideoDownloader cancellation", () => {
  it("deduplicates queued double-click cancellation and waits for API confirmation", async () => {
    const scenario = new MediaJobFetchScenario();
    const cancellation = deferredResponse();
    scenario.deleteSteps.push(cancellation.step);
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 500 }} />
    );
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.element(screen.getByText("Задача поставлена в очередь")).toBeVisible();

    await userEvent.dblClick(screen.getByRole("button", { name: "Отменить" }));
    expect(scenario.cancelCalls).toHaveLength(1);
    await expect.element(screen.getByRole("button", { name: "Отменяем…" })).toBeDisabled();
    expect(screen.getByText("Подготовка файла отменена").query()).toBeNull();

    cancellation.resolve(success(jobSnapshot("cancelled")));
    await expect.element(screen.getByText("Подготовка файла отменена").first()).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Начать заново" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
    expect(scenario.pollCalls).toHaveLength(0);
  });

  it("cancels a running job through the canonical job route", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.getSteps.push(success(jobSnapshot("running", { progress: 55 })));
    scenario.deleteSteps.push(success(jobSnapshot("cancelled")));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, regularPollDelayMs: 500 }} />
    );
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.element(screen.getByText("Загружаем и проверяем файл")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await expect.element(screen.getByText("Подготовка файла отменена").first()).toBeVisible();
    expect(scenario.cancelCalls).toHaveLength(1);
    expect(scenario.cancelCalls[0]).toMatchObject({ path: `/api/jobs/${JOB_ID}`, method: "DELETE" });
  });
});

describe("VideoDownloader safe terminal errors", () => {
  it("shows a safe extract failure and removes internal details", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps[0] = failure(
      API_ERROR_CODES.EXTRACTION_FAILED,
      "ffmpeg stderr /private/tmp/source.mp4 https://internal.example/source",
      502
    );
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), PUBLIC_PAGE_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));

    await expect.element(screen.getByText("Не удалось получить данные видео.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Начать заново" })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/ffmpeg|stderr|\/private\/tmp|internal\.example/i);
  });

  it("shows RIGHTS_NOT_CONFIRMED and UNSUPPORTED_PRESET as safe POST failures", async () => {
    for (const response of [
      failure(API_ERROR_CODES.RIGHTS_NOT_CONFIRMED, "Подтвердите права на загрузку этого контента.", 403),
      failure(API_ERROR_CODES.UNSUPPORTED_PRESET, "Выбранный режим обработки не поддерживается.", 422)
    ]) {
      const scenario = new MediaJobFetchScenario();
      scenario.downloadSteps[0] = response;
      vi.stubGlobal("fetch", scenario.fetch);
      const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
      await extractVideo(screen);
      await submitOriginal(screen);
      await expect.element(screen.getByText("Не удалось подготовить файл")).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Начать заново" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Повторить" }).query()).toBeNull();
      await screen.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("allows an explicit retry after a recoverable POST network failure", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.downloadSteps[0] = new TypeError("offline");
    scenario.downloadSteps.push(success(createJobData(), 202));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 500 }} />
    );
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.element(screen.getByText("Не удалось связаться с сервером")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await expect.element(screen.getByText("Задача поставлена в очередь")).toBeVisible();
    expect(scenario.downloadCalls).toHaveLength(2);
  });

  it("sanitizes failed job details and keeps the terminal state in an aria-live region", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.getSteps.push(success(jobSnapshot("failed", {
      errorMessage: "ffmpeg stderr /private/tmp/output.partial stack https://internal.example"
    })));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await submitOriginal(screen);

    const safeMessage = screen.getByText("Не удалось обработать задачу.");
    await expect.element(safeMessage).toBeVisible();
    expect(safeMessage.element().closest("[aria-live]")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/ffmpeg|stderr|\/private\/tmp|internal\.example/i);
  });

  it("maps a canonical 404 to expired and stops polling", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.getSteps.push(failure(
      API_ERROR_CODES.JOB_NOT_FOUND,
      "Задание не найдено или срок его хранения истёк.",
      404
    ));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.element(screen.getByText("Срок хранения файла истёк", { exact: true })).toBeVisible();
    const calls = scenario.pollCalls.length;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 60));
    expect(scenario.pollCalls).toHaveLength(calls);
  });

  it("ends bounded polling on network errors without an infinite loop", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.getFallback = new TypeError("offline");
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.element(screen.getByText("Не удалось получить статус задачи").first()).toBeVisible();
    const calls = scenario.pollCalls.length;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
    expect(scenario.pollCalls).toHaveLength(calls);
  });

  it("shows polling timeout without automatically deleting the server job", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.getFallback = () => success(jobSnapshot("queued"));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, maxPollingDurationMs: 65 }} />
    );
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.element(screen.getByText("Подготовка занимает больше времени, чем ожидалось").first()).toBeVisible();
    expect(scenario.cancelCalls).toHaveLength(0);
    await expect.element(screen.getByRole("button", { name: "Повторить" })).toBeVisible();
  });

  it("shows AUDIO_STREAM_NOT_FOUND for M4A without promising MP3", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.downloadSteps[0] = success(createJobData("audio-only"), 202);
    scenario.getSteps.push(success(jobSnapshot("failed", {
      preset: "audio-only",
      errorCode: API_ERROR_CODES.AUDIO_STREAM_NOT_FOUND,
      errorMessage: "В медиафайле не найдена аудиодорожка."
    })));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await userEvent.click(screen.getByText("Только аудио", { exact: true }));
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Извлечь аудио" }));
    await expect.element(screen.getByText("В медиафайле не найдена аудиодорожка.")).toBeVisible();
    expect(document.body.textContent).not.toContain("MP3");
  });
});

describe("VideoDownloader component races and cleanup", () => {
  it("aborts an in-flight extract on unmount without rendering an error", async () => {
    const scenario = new MediaJobFetchScenario();
    const extract = deferredResponse({ rejectOnAbort: true });
    scenario.extractSteps[0] = extract.step;
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), PUBLIC_PAGE_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText("Проверяем ссылку и получаем доступные форматы")).toBeVisible();
    await screen.unmount();
    expect(extract.getSignal()?.aborted).toBe(true);
    expect(document.body.textContent).not.toContain("Не удалось");
  });

  it("clears a scheduled poll timer on unmount", async () => {
    const scenario = new MediaJobFetchScenario();
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 120 }} />
    );
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.element(screen.getByText("Задача поставлена в очередь")).toBeVisible();
    await screen.unmount();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
    expect(scenario.pollCalls).toHaveLength(0);
  });

  it("does not overlap polling GETs and ignores a late ready after confirmed cancellation", async () => {
    const scenario = new MediaJobFetchScenario();
    const runningGet = deferredResponse();
    scenario.getSteps.push(runningGet.step);
    scenario.deleteSteps.push(success(jobSnapshot("cancelled")));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await submitOriginal(screen);
    await expect.poll(() => scenario.pollCalls.length).toBe(1);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    expect(scenario.pollCalls).toHaveLength(1);
    expect(scenario.maxConcurrentGets).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await expect.element(screen.getByText("Подготовка файла отменена").first()).toBeVisible();
    expect(runningGet.getSignal()?.aborted).toBe(true);
    runningGet.resolve(success(jobSnapshot("ready")));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
    await expect.element(screen.getByText("Подготовка файла отменена").first()).toBeVisible();
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();
  });
});

describe("VideoDownloader terminal restart", () => {
  it("restarts failed, cancelled and expired flows with clean rights and default preset", async () => {
    const terminalScenarios = [
      {
        title: "Не удалось подготовить файл",
        step: success(jobSnapshot("failed"))
      },
      {
        title: "Подготовка файла отменена",
        step: success(jobSnapshot("cancelled"))
      },
      {
        title: "Срок хранения файла истёк",
        step: failure(API_ERROR_CODES.JOB_NOT_FOUND, "Задание не найдено.", 404)
      }
    ] as const;

    for (const terminal of terminalScenarios) {
      const scenario = new MediaJobFetchScenario();
      scenario.extractSteps.push(success(VIDEO_METADATA));
      scenario.getSteps.push(terminal.step);
      vi.stubGlobal("fetch", scenario.fetch);
      const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
      await extractVideo(screen);
      await submitOriginal(screen);
      await expect.element(screen.getByText(terminal.title, { exact: true }).first()).toBeVisible();
      const completedPolls = scenario.pollCalls.length;

      await userEvent.click(screen.getByRole("button", { name: "Начать заново" }));
      expect(screen.getByText(terminal.title, { exact: true }).first().query()).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
      await expect.element(screen.getByText(VIDEO_METADATA.title)).toBeVisible();
      await expect.element(screen.getByLabelText(RIGHTS_LABEL)).not.toBeChecked();
      await expect.element(screen.getByRole("radio", { name: /Скачать оригинал/ })).toBeChecked();
      await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
      expect(scenario.pollCalls).toHaveLength(completedPolls);
      await screen.unmount();
      vi.unstubAllGlobals();
    }
  });
});
