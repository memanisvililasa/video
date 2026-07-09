import { AppError } from "@/lib/errors";
import { genericDirectMediaExtractor } from "@/lib/extractors/generic-direct-media";
import { placeholderExtractors } from "@/lib/extractors/placeholders";
import type { Extractor } from "@/lib/extractors/types";

const extractors: Extractor[] = [
  ...placeholderExtractors,
  genericDirectMediaExtractor
];

export function listExtractors(): readonly Extractor[] {
  return extractors;
}

export function findExtractor(url: URL): Extractor | undefined {
  return extractors.find((extractor) => extractor.supports(url));
}

export function requireExtractor(url: URL): Extractor {
  const extractor = findExtractor(url);
  if (!extractor) {
    throw new AppError("UNSUPPORTED_URL", "Ссылка не поддерживается", 400);
  }
  return extractor;
}
