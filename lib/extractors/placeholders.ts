import { AppError } from "@/lib/errors";
import { API_ERROR_CODES, type VideoMetadata } from "@/lib/types";
import type { DownloadContext, Extractor, ExtractorContext } from "@/lib/extractors/types";

type PlatformPlaceholder = {
  id: string;
  name: string;
  domains: readonly string[];
};

const platforms: readonly PlatformPlaceholder[] = [
  { id: "youtube", name: "YouTube", domains: ["youtube.com", "youtu.be", "youtube-nocookie.com"] },
  { id: "tiktok", name: "TikTok", domains: ["tiktok.com"] },
  { id: "instagram", name: "Instagram", domains: ["instagram.com"] },
  { id: "facebook", name: "Facebook", domains: ["facebook.com", "fb.watch"] },
  { id: "x", name: "X", domains: ["x.com", "twitter.com"] },
  { id: "reddit", name: "Reddit", domains: ["reddit.com", "redd.it"] },
  { id: "vimeo", name: "Vimeo", domains: ["vimeo.com", "player.vimeo.com"] }
];

function hostnameMatches(hostname: string, domains: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function errorFor(platform: PlatformPlaceholder): AppError {
  return new AppError(
    API_ERROR_CODES.UNSUPPORTED_URL,
    `${platform.name}: ссылки на страницы пока не поддерживаются. Используйте прямую публичную ссылку на .mp4, .webm или .mov.`,
    400
  );
}

function createPlaceholder(platform: PlatformPlaceholder): Extractor {
  return {
    id: platform.id,
    name: platform.name,
    supports(url: URL): boolean {
      return hostnameMatches(url.hostname, platform.domains);
    },
    async extract(_url: URL, _context?: ExtractorContext): Promise<VideoMetadata> {
      throw errorFor(platform);
    },
    async download(_url: URL, _formatId: string, _context: DownloadContext) {
      throw errorFor(platform);
    }
  };
}

export const placeholderExtractors: readonly Extractor[] = platforms.map(createPlaceholder);
