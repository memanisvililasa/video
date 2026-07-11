import type { ProcessingPreset } from "@/lib/api/media-job-dto";

export const USER_PROCESSING_PRESETS = Object.freeze([
  "original",
  "compatible-mp4",
  "audio-only"
] as const satisfies readonly ProcessingPreset[]);

export type UserProcessingPreset = (typeof USER_PROCESSING_PRESETS)[number];

export type MediaPresetOption = Readonly<{
  value: UserProcessingPreset;
  title: string;
  description: string;
  benefit?: string;
  note?: string;
}>;

export const MEDIA_PRESET_OPTIONS: readonly MediaPresetOption[] = Object.freeze([
  Object.freeze({
    value: "original",
    title: "Скачать оригинал",
    description: "Без перекодирования. Сохраняет исходное качество и формат.",
    benefit: "Быстрее"
  }),
  Object.freeze({
    value: "compatible-mp4",
    title: "Совместимый MP4",
    description: "Видео H.264 и аудио AAC для большинства устройств и редакторов.",
    note: "Максимальное разрешение обработки — 1080p"
  }),
  Object.freeze({
    value: "audio-only",
    title: "Только аудио",
    description: "Извлечение аудиодорожки в AAC/M4A.",
    note: "192 кбит/с"
  })
]);

const USER_PRESET_SET: ReadonlySet<string> = new Set(USER_PROCESSING_PRESETS);

export function isUserProcessingPreset(value: unknown): value is UserProcessingPreset {
  return typeof value === "string" && USER_PRESET_SET.has(value);
}

export function getPresetTitle(preset: UserProcessingPreset): string {
  switch (preset) {
    case "original":
      return "Скачать оригинал";
    case "compatible-mp4":
      return "Совместимый MP4";
    case "audio-only":
      return "Только аудио · M4A";
    default: {
      const exhaustive: never = preset;
      throw new TypeError(`Unsupported user preset: ${String(exhaustive)}`);
    }
  }
}

export function getPresetSubmitLabel(preset: UserProcessingPreset): string {
  switch (preset) {
    case "original":
      return "Подготовить оригинал";
    case "compatible-mp4":
      return "Подготовить MP4";
    case "audio-only":
      return "Извлечь аудио";
    default: {
      const exhaustive: never = preset;
      throw new TypeError(`Unsupported user preset: ${String(exhaustive)}`);
    }
  }
}

export function getPresetRunningMessage(preset: UserProcessingPreset): string {
  switch (preset) {
    case "original":
      return "Загружаем и проверяем файл";
    case "compatible-mp4":
      return "Подготавливаем совместимый MP4";
    case "audio-only":
      return "Извлекаем аудиодорожку";
    default: {
      const exhaustive: never = preset;
      throw new TypeError(`Unsupported user preset: ${String(exhaustive)}`);
    }
  }
}
