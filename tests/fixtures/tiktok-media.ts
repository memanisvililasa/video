export const SYNTHETIC_TIKTOK_VIDEO_ID = "7000000000000000001";
export const SYNTHETIC_TIKTOK_OTHER_VIDEO_ID = "7000000000000000002";
export const SYNTHETIC_TIKTOK_NOW_MS = 1_899_900_000_000;
export const SYNTHETIC_TIKTOK_EXPIRE = 1_900_000_000;

export function syntheticTikTokLocator(
  hostname = "v16-webapp-prime.tiktok.com",
  expire: number | string = SYNTHETIC_TIKTOK_EXPIRE,
  suffix = "a"
): string {
  return `https://${hostname}/synthetic/video-${suffix}.mp4?expire=${expire}&signature=synthetic-${suffix}`;
}

export function syntheticTikTokMediaPage(options: Readonly<{
  videoId?: string;
  locators?: readonly string[];
  urlKey?: string;
  hasAudio?: boolean;
  videoOverrides?: Readonly<Record<string, unknown>>;
  itemOverrides?: Readonly<Record<string, unknown>>;
}> = {}): Buffer {
  const videoId = options.videoId ?? SYNTHETIC_TIKTOK_VIDEO_ID;
  const locators = options.locators ?? [
    syntheticTikTokLocator("v16-webapp-prime.tiktok.com", SYNTHETIC_TIKTOK_EXPIRE, "a"),
    syntheticTikTokLocator("v19-webapp-prime.tiktok.com", SYNTHETIC_TIKTOK_EXPIRE, "b"),
    syntheticTikTokLocator("www.tiktok.com", SYNTHETIC_TIKTOK_EXPIRE, "broken")
  ];
  const item = {
    id: videoId,
    desc: "Synthetic TikTok media fixture",
    contentType: "video",
    video: {
      duration: 12,
      width: 1080,
      height: 1920,
      hasAudio: options.hasAudio ?? true,
      bitrateInfo: [{
        BitRate: 2_000_000,
        FPS: 30,
        PlayAddr: {
          UrlKey: options.urlKey ?? "synthetic_h264_576p_30",
          DataSize: 3_000_000,
          UrlList: locators
        }
      }],
      ...options.videoOverrides
    },
    ...options.itemOverrides
  };
  const state = {
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        statusCode: 0,
        itemInfo: { itemStruct: item }
      }
    }
  };
  return Buffer.from(
    `<!doctype html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(state)}</script>`
  );
}
