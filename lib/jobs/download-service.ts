import { AppError } from "@/lib/errors";
import type { DownloadRequest, PreparedFile } from "@/lib/types";

export async function prepareDownload(_request: DownloadRequest): Promise<PreparedFile> {
  throw new AppError("NOT_IMPLEMENTED", "Подготовка файла будет добавлена на следующем этапе.", 501);
}
