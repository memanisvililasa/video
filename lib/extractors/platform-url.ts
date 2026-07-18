import { canonicalizeVimeoSourceInput, isVimeoPageHostname } from "@/lib/extractors/vimeo-url";
import { canonicalizeYouTubeSourceInput, isYouTubePageHostname } from "@/lib/extractors/youtube-url";

export function canonicalizePlatformSourceInput(value: string, validatedUrl: URL): URL {
  let original: URL;
  try {
    original = new URL(value.trim());
  } catch {
    return validatedUrl;
  }
  if (isVimeoPageHostname(original.hostname)) {
    return canonicalizeVimeoSourceInput(value, validatedUrl);
  }
  if (isYouTubePageHostname(original.hostname)) {
    return canonicalizeYouTubeSourceInput(value, validatedUrl);
  }
  return validatedUrl;
}
