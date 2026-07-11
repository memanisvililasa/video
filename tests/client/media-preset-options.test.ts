import { describe, expect, it } from "vitest";
import { PROCESSING_PRESETS, isProcessingPreset } from "@/lib/api/media-job-dto";
import {
  MEDIA_PRESET_OPTIONS,
  USER_PROCESSING_PRESETS,
  getPresetRunningMessage,
  getPresetSubmitLabel,
  isUserProcessingPreset,
  type UserProcessingPreset
} from "@/lib/client/media-preset-options";

describe("client-safe media preset options", () => {
  it("contains exactly the three user-facing presets", () => {
    expect(USER_PROCESSING_PRESETS).toEqual(["original", "compatible-mp4", "audio-only"]);
    expect(MEDIA_PRESET_OPTIONS.map((option) => option.value)).toEqual(USER_PROCESSING_PRESETS);
    expect(MEDIA_PRESET_OPTIONS.some((option) => option.value === ("remux-to-mp4" as UserProcessingPreset))).toBe(false);
  });

  it("provides the required labels, descriptions and notes", () => {
    expect(MEDIA_PRESET_OPTIONS).toEqual([
      {
        value: "original",
        title: "Скачать оригинал",
        description: "Без перекодирования. Сохраняет исходное качество и формат.",
        benefit: "Быстрее"
      },
      {
        value: "compatible-mp4",
        title: "Совместимый MP4",
        description: "Видео H.264 и аудио AAC для большинства устройств и редакторов.",
        note: "Максимальное разрешение обработки — 1080p"
      },
      {
        value: "audio-only",
        title: "Только аудио",
        description: "Извлечение аудиодорожки в AAC/M4A.",
        note: "192 кбит/с"
      }
    ]);
  });

  it.each([
    ["original", "Подготовить оригинал"],
    ["compatible-mp4", "Подготовить MP4"],
    ["audio-only", "Извлечь аудио"]
  ] as const)("maps %s to its submit label", (preset, label) => {
    expect(getPresetSubmitLabel(preset)).toBe(label);
  });

  it.each([
    ["original", "Загружаем и проверяем файл"],
    ["compatible-mp4", "Подготавливаем совместимый MP4"],
    ["audio-only", "Извлекаем аудиодорожку"]
  ] as const)("maps %s to its running message", (preset, message) => {
    expect(getPresetRunningMessage(preset)).toBe(message);
  });

  it("uses exhaustive mappings for every user preset", () => {
    const submitLabels: Record<UserProcessingPreset, string> = {
      original: "Подготовить оригинал",
      "compatible-mp4": "Подготовить MP4",
      "audio-only": "Извлечь аудио"
    };
    const runningMessages: Record<UserProcessingPreset, string> = {
      original: "Загружаем и проверяем файл",
      "compatible-mp4": "Подготавливаем совместимый MP4",
      "audio-only": "Извлекаем аудиодорожку"
    };
    for (const preset of USER_PROCESSING_PRESETS) {
      expect(getPresetSubmitLabel(preset)).toBe(submitLabels[preset]);
      expect(getPresetRunningMessage(preset)).toBe(runningMessages[preset]);
    }
  });

  it("keeps remux-to-mp4 valid for the API but hidden from user input", () => {
    expect(PROCESSING_PRESETS).toContain("remux-to-mp4");
    expect(isProcessingPreset("remux-to-mp4")).toBe(true);
    expect(isUserProcessingPreset("remux-to-mp4")).toBe(false);
    expect(isUserProcessingPreset("enhance-4k")).toBe(false);
  });
});
