import type { AllowedVideoResponse, CheckVideoResponse, NotAllowedVideoResponse } from "@/lib/types";

type PlatformDefinition = {
  name: string;
  hosts: readonly string[];
  officialOption: string;
};

const platformDefinitions: readonly PlatformDefinition[] = [
  {
    name: "YouTube",
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
    officialOption: "Используйте официальные функции YouTube: Скачать (если доступно автором) или Смотреть позже."
  },
  {
    name: "Vimeo",
    hosts: ["vimeo.com", "www.vimeo.com", "player.vimeo.com"],
    officialOption: "Используйте кнопку Download на странице Vimeo, если её включил владелец видео."
  },
  {
    name: "TikTok",
    hosts: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com"],
    officialOption: "Используйте штатную функцию «Сохранить видео», когда автор и платформа её предоставляют."
  },
  {
    name: "Instagram",
    hosts: ["instagram.com", "www.instagram.com"],
    officialOption: "Используйте встроенное сохранение Instagram или запросите файл у автора."
  },
  {
    name: "Facebook",
    hosts: ["facebook.com", "www.facebook.com", "fb.watch"],
    officialOption: "Используйте официальные инструменты Facebook или обратитесь к владельцу контента."
  },
  {
    name: "X",
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    officialOption: "Используйте функции сохранения X или получите разрешение и файл напрямую у автора."
  }
];

export const DEMO_HOST = "demo.videosave.local";

export function isSupportedHostname(hostname: string): boolean {
  return hostname === DEMO_HOST || platformDefinitions.some((platform) => platform.hosts.includes(hostname));
}

export function getPlatformForHostname(hostname: string): PlatformDefinition | undefined {
  return platformDefinitions.find((platform) => platform.hosts.includes(hostname));
}

export function mockAllowedVideo(): AllowedVideoResponse {
  return {
    status: "allowed",
    platform: "VideoSave Demo",
    title: "Демонстрационный ролик Creative Commons",
    author: "VideoSave Studio",
    duration: "00:24",
    thumbnail: "/demo-thumbnail.svg",
    formats: [
      {
        quality: "720p",
        format: "MP4",
        size: "4.8 MB",
        downloadUrl: "/api/demo-download?format=720p"
      },
      {
        quality: "480p",
        format: "MP4",
        size: "2.6 MB",
        downloadUrl: "/api/demo-download?format=480p"
      }
    ],
    isDemo: true
  };
}

export function buildNotAllowedResponse(hostname: string): NotAllowedVideoResponse {
  const platform = getPlatformForHostname(hostname);

  return {
    status: "not_allowed",
    platform: platform?.name ?? "Неизвестная платформа",
    reason: platform
      ? "Сервис не запрашивает и не извлекает медиафайлы со сторонних платформ без явно подтверждённого разрешения через официальный API."
      : "Этот адрес не относится к поддерживаемому источнику. Мы работаем только с заранее одобренными источниками и официальными методами.",
    officialOption: platform?.officialOption ?? "Проверьте официальный способ сохранения на исходной платформе или получите файл у автора."
  };
}

/**
 * Only a controlled demo source is allowed until an official API adapter has
 * positively verified both the content rights and a provider-issued download URL.
 */
export function resolveMockVideo(url: URL): CheckVideoResponse {
  if (url.hostname === DEMO_HOST && url.pathname === "/allowed/creative-commons-clip") {
    return mockAllowedVideo();
  }

  return buildNotAllowedResponse(url.hostname);
}
