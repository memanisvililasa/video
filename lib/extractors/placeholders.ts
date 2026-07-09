import { AppError } from "@/lib/errors";
import { API_ERROR_CODES, type VideoMetadata } from "@/lib/types";
import type { DownloadContext, Extractor, ExtractorContext } from "@/lib/extractors/types";

type PlatformPlaceholder = {
  id: string;
  name: string;
  domains: readonly string[];
  protected?: boolean;
};

const platforms: readonly PlatformPlaceholder[] = [
  { id: "youtube", name: "YouTube", domains: ["youtube.com", "youtu.be", "youtube-nocookie.com"], protected: true },
  { id: "tiktok", name: "TikTok", domains: ["tiktok.com"], protected: true },
  { id: "instagram", name: "Instagram", domains: ["instagram.com"], protected: true },
  { id: "facebook", name: "Facebook", domains: ["facebook.com", "fb.watch"], protected: true },
  { id: "x", name: "X", domains: ["x.com", "twitter.com"], protected: true },
  { id: "reddit", name: "Reddit", domains: ["reddit.com", "redd.it"], protected: false },
  { id: "vimeo", name: "Vimeo", domains: ["vimeo.com", "player.vimeo.com"], protected: false }
];

function hostnameMatches(hostname: string, domains: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function errorFor(platform: PlatformPlaceholder): AppError {
  if (platform.protected) {
    return new AppError(API_ERROR_CODES.PROTECTED_CONTENT, `${platform.name}: приватный, защищённый или требующий авторизации контент не поддерживается.`, 403);
  }

  return new AppError(API_ERROR_CODES.UNSUPPORTED_URL, `${platform.name} пока не поддерживается.`, 400);
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
