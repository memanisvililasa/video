import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { VideoDownloader } from "@/components/video-downloader";
import {
  FAST_POLLING_POLICY,
  MediaJobFetchScenario,
  PUBLIC_PAGE_URL,
  jobSnapshot,
  readyResult,
  success
} from "@/tests/browser/helpers/media-job-fetch-scenario";

const RIGHTS_LABEL = "Я подтверждаю, что скачиваю своё видео или контент, на который у меня есть разрешение.";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VideoDownloader responsive smoke", () => {
  it.each([
    ["desktop", 1280, 900],
    ["mobile", 375, 760]
  ] as const)("keeps controls and a long ready filename accessible on %s", async (_name, width, height) => {
    await page.viewport(width, height);
    const scenario = new MediaJobFetchScenario();
    const longFilename = `${"безопасное-длинное-имя-файла-".repeat(4)}<img onerror=alert(1)>.mp4`;
    scenario.getSteps.push(success(jobSnapshot("ready", {
      result: readyResult("original", { filename: longFilename })
    })));
    vi.stubGlobal("fetch", scenario.fetch);
    const screen = await render(<VideoDownloader pollingPolicy={FAST_POLLING_POLICY} />);

    await expect.element(screen.getByLabelText("Ссылка на видео")).toBeVisible();
    await userEvent.fill(screen.getByLabelText("Ссылка на видео"), PUBLIC_PAGE_URL);
    await userEvent.click(screen.getByRole("button", { name: "Проверить ссылку" }));
    await expect.element(screen.getByRole("group", { name: "Что подготовить" })).toBeVisible();
    await userEvent.click(screen.getByLabelText(RIGHTS_LABEL));
    await userEvent.click(screen.getByRole("button", { name: "Подготовить оригинал" }));

    await expect.element(screen.getByText(longFilename)).toBeVisible();
    await expect.element(screen.getByRole("link", { name: "Скачать файл" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Подготовить другой файл" })).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  });
});
