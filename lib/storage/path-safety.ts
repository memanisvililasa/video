import path from "node:path";
import { AppError } from "@/lib/errors";
import { API_ERROR_CODES } from "@/lib/types";
import { sanitizeFilename } from "@/lib/security/sanitize";

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export function normalizeStorageRoot(storagePath: string): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), storagePath);
}

export function assertSafePath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedCandidate;
  }

  throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Некорректный путь хранения файла.", 500);
}

export function safeJoin(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (!segment || segment.includes("/") || segment.includes("\\") || segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment)) {
      throw new AppError(API_ERROR_CODES.DOWNLOAD_FAILED, "Некорректный сегмент пути хранения файла.", 500);
    }
  }

  return assertSafePath(root, path.join(root, ...segments));
}

export function normalizeDownloadFilename(value: string, extension: string): string {
  const sanitized = sanitizeFilename(value, { fallback: "video", maxLength: 140 });
  const basename = sanitized.ok ? sanitized.value : "video";
  const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  return basename.toLowerCase().endsWith(`.${safeExtension}`) ? basename : `${basename}.${safeExtension}`;
}
