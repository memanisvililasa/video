import { AppError } from "@/lib/errors";
import type { Extractor } from "@/lib/extractors/types";

const extractors: Extractor[] = [];

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
