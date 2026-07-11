import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render, type RenderResult } from "vitest-browser-react";
import { VideoDownloader } from "@/components/video-downloader";
import {
  DIRECT_MEDIA_URL,
  FAST_POLLING_POLICY,
  FILE_ID,
  JOB_ID,
  MediaJobFetchScenario,
  PUBLIC_PAGE_URL,
  VIDEO_METADATA,
  createJobData,
  deferredResponse,
  jobSnapshot,
  readyResult,
  success
} from "@/tests/browser/helpers/media-job-fetch-scenario";

const RIGHTS_LABEL = "Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.";

async function extractVideo(screen: RenderResult): Promise<void> {
  await userEvent.fill(screen.getByLabelText("Ссылка на видео"), PUBLIC_PAGE_URL);
  await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
  await expect.element(screen.getByText(VIDEO_METADATA.title)).toBeVisible();
}

async function confirmAndSubmit(screen: RenderResult, buttonName: string): Promise<void> {
  await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
  const submit = screen.getByRole("button", { name: buttonName });
  await expect.element(submit).toBeEnabled();
  await userEvent.click(submit);
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VideoDownloader happy path", () => {
  it("runs extract → compatible MP4 → queued → running → ready without automatic download", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.downloadSteps[0] = success(createJobData("compatible-mp4"), 202);
    const ready = deferredResponse();
    scenario.getSteps.push(
      success(jobSnapshot("running", { preset: "compatible-mp4", progress: 64 })),
      ready.step
    );
    vi.stubGlobal("fetch", scenario.fetch);

    const screen = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 120 }} />
    );
    await extractVideo(screen);

    await expect.element(screen.getByRole("radio", { name: /720p/ })).toBeVisible();
    await userEvent.click(screen.getByText("1080p", { exact: true }));
    await userEvent.click(screen.getByText("Совместимый MP4", { exact: true }));
    await confirmAndSubmit(screen, "Подготовить MP4");

    await expect.element(screen.getByText("Задача поставлена в очередь")).toBeVisible();
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();

    const requestBody = JSON.parse(scenario.downloadCalls[0]?.body ?? "null") as Record<string, unknown>;
    expect(requestBody).toEqual({
      url: PUBLIC_PAGE_URL,
      formatId: "format-1080",
      processingPreset: "compatible-mp4",
      rightsConfirmed: true
    });
    for (const forbidden of [
      "outputPath", "filename", "codec", "filters", "ffmpeg", "args",
      "cookies", "credentials", "token", DIRECT_MEDIA_URL
    ]) {
      expect(JSON.stringify(requestBody).toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    await expect.element(screen.getByText("Подготавливаем совместимый MP4")).toBeVisible();
    const progress = screen.getByRole("progressbar", { name: "Прогресс подготовки файла" });
    await expect.element(progress).toHaveAttribute("aria-valuemin", "0");
    await expect.element(progress).toHaveAttribute("aria-valuemax", "100");
    await expect.element(progress).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();

    ready.resolve(success(jobSnapshot("ready", { preset: "compatible-mp4" })));
    const download = screen.getByRole("link", { name: "Скачать файл" });
    await expect.element(download).toBeVisible();
    await expect.element(download).toHaveAttribute("href", `/api/file/${FILE_ID}`);
    await expect.element(download).toHaveAttribute("download", "public-video.mp4");
    await expect.element(screen.getByText("public-video.mp4")).toBeVisible();
    await expect.element(screen.getByText("MP4 · video/mp4")).toBeVisible();
    await expect.element(screen.getByText("1,5 МБ")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Подготовить другой файл" })).toBeVisible();

    const pollCount = scenario.pollCalls.length;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 80));
    expect(scenario.pollCalls).toHaveLength(pollCount);
    expect(scenario.calls.some((call) => call.path.startsWith("/api/file/"))).toBe(false);
    expect(document.body.textContent).not.toContain(JOB_ID);
    expect(document.body.textContent).not.toContain(FILE_ID);
    expect(document.body.textContent).not.toContain(DIRECT_MEDIA_URL);
  });

  it("requires rights and exposes only the three accessible user presets", async () => {
    const scenario = new MediaJobFetchScenario();
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);

    const presetGroup = screen.getByRole("group", { name: "Что подготовить" });
    await expect.element(presetGroup).toBeVisible();
    expect(presetGroup.getByRole("radio").elements()).toHaveLength(3);

    const original = screen.getByRole("radio", { name: /Скачать оригинал/ });
    const compatible = screen.getByRole("radio", { name: /Совместимый MP4/ });
    const audio = screen.getByRole("radio", { name: /Только аудио/ });
    await expect.element(original).toBeVisible();
    await expect.element(compatible).toBeVisible();
    await expect.element(audio).toBeVisible();
    await expect.element(original).toBeChecked();
    await expect.element(screen.getByText("Максимальное разрешение обработки — 1080p")).toBeVisible();
    await expect.element(screen.getByText("Результат: M4A.")).toBeVisible();
    await expect.element(screen.getByText("192 кбит/с")).toBeVisible();
    expect(screen.getByText("remux-to-mp4").query()).toBeNull();

    const checkbox = screen.getByLabelText(RIGHTS_LABEL);
    const originalSubmit = screen.getByRole("button", { name: "Подготовить оригинал" });
    await expect.element(checkbox).not.toBeChecked();
    await expect.element(originalSubmit).toBeDisabled();

    document.body.focus();
    await userEvent.tab();
    await expect.element(screen.getByRole("radio", { name: /720p/ })).toHaveFocus();

    await userEvent.click(screen.getByText("Только аудио", { exact: true }));
    await expect.element(audio).toBeChecked();
    await expect.element(screen.getByRole("button", { name: "Извлечь аудио" })).toBeDisabled();
    await userEvent.click(screen.getByText("Скачать оригинал", { exact: true }));
    original.element().focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(compatible).toBeChecked();
    await expect.element(compatible).toHaveFocus();

    const focusedLabel = document.querySelector<HTMLLabelElement>('label[for="processing-preset-compatible-mp4"]');
    expect(focusedLabel).not.toBeNull();
    expect(globalThis.getComputedStyle(focusedLabel!).boxShadow).not.toBe("none");

    await userEvent.click(checkbox);
    await expect.element(checkbox).toBeChecked();
    await expect.element(screen.getByRole("button", { name: "Подготовить MP4" })).toBeEnabled();
  });

  it("blocks rights controls while active and never confirms rights automatically", async () => {
    const scenario = new MediaJobFetchScenario();
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(
      <VideoDownloader pollingPolicy={{ ...FAST_POLLING_POLICY, firstPollDelayMs: 400 }} />
    );
    await extractVideo(screen);

    const checkbox = screen.getByLabelText(RIGHTS_LABEL);
    await expect.element(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Подготовить оригинал" }));
    await expect.element(screen.getByText("Задача поставлена в очередь")).toBeVisible();
    expect(screen.getByRole("checkbox").query()).toBeNull();
    expect(screen.getByRole("radio", { name: /Скачать оригинал/ }).query()).toBeNull();
  });

  it("START_NEW_JOB clears result and rights and restores the default preset", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.extractSteps.push(success(VIDEO_METADATA));
    scenario.downloadSteps[0] = success(createJobData("audio-only"), 202);
    scenario.getSteps.push(success(jobSnapshot("ready", { preset: "audio-only" })));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await userEvent.click(screen.getByText("Только аудио", { exact: true }));
    await confirmAndSubmit(screen, "Извлечь аудио");
    await expect.element(screen.getByRole("link", { name: "Скачать файл" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Подготовить другой файл" }));
    expect(screen.getByText("public-video.m4a").query()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByText(VIDEO_METADATA.title)).toBeVisible();
    await expect.element(screen.getByLabelText(RIGHTS_LABEL)).not.toBeChecked();
    await expect.element(screen.getByRole("radio", { name: /Скачать оригинал/ })).toBeChecked();
  });

  it("starts download only after the explicit user click", async () => {
    const scenario = new MediaJobFetchScenario();
    scenario.getSteps.push(success(jobSnapshot("ready")));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await confirmAndSubmit(screen, "Подготовить оригинал");
    const download = screen.getByRole("link", { name: "Скачать файл" });
    await expect.element(download).toBeVisible();
    expect(screen.getByText("Скачивание началось").query()).toBeNull();

    download.element().addEventListener("click", (event) => event.preventDefault(), { once: true });
    await userEvent.click(download);
    await expect.element(screen.getByText("Скачивание началось")).toBeVisible();
    expect(scenario.calls.some((call) => call.path.startsWith("/api/file/"))).toBe(false);
  });

  it("rejects an external ready URL and never renders it as a download link", async () => {
    const scenario = new MediaJobFetchScenario();
    const unsafe = readyResult("original", { downloadUrl: "https://attacker.example/output.mp4" });
    scenario.getSteps.push(success(jobSnapshot("ready", { result: unsafe })));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);
    await extractVideo(screen);
    await confirmAndSubmit(screen, "Подготовить оригинал");
    await expect.element(screen.getByText("Получен некорректный ответ сервера.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Скачать файл" }).query()).toBeNull();
    expect(document.body.textContent).not.toContain("attacker.example");
  });
});
