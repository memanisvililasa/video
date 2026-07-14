import "server-only";
import { createReadStream } from "node:fs";
import { parseApplicationProcessRole } from "@/lib/config/env";
import type { PersistentDownloadJobService } from "@/lib/jobs/postgres/web-service";
import type { MediaFileDelivery } from "@/lib/storage/file-delivery";

export type WebApiRuntime = Readonly<{
  role: "local" | "web";
  authority: "memory" | "postgres";
  jobs: PersistentDownloadJobService;
  files: MediaFileDelivery;
  close(): Promise<void>;
}>;

export type RoleAwareWebRuntimeResolver = Readonly<{
  resolve(): Promise<WebApiRuntime>;
  close(): Promise<void>;
}>;

export type CreateRoleAwareWebRuntimeResolverOptions = Readonly<{
  source: () => Readonly<Record<string, string | undefined>>;
  createLocal?: () => Promise<WebApiRuntime>;
  createWeb?: (
    source: Readonly<Record<string, string | undefined>>
  ) => Promise<WebApiRuntime>;
}>;

async function createLocalWebRuntime(): Promise<WebApiRuntime> {
  const [downloadService, localStorage] = await Promise.all([
    import("@/lib/jobs/download-service"),
    import("@/lib/storage/local-storage")
  ]);
  return Object.freeze({
    role: "local" as const,
    authority: "memory" as const,
    jobs: Object.freeze({
      enqueueDownloadJob: downloadService.enqueueDownloadJob,
      getDownloadJob: downloadService.getDownloadJob,
      cancelDownloadJob: downloadService.cancelDownloadJob
    }),
    files: Object.freeze({
      async get(fileId: string) {
        const file = await localStorage.getPreparedFile(fileId);
        if (!file) return null;
        const stream = createReadStream(file.path);
        return Object.freeze({
          fileId: file.id,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          expiresAt: file.expiresAt,
          stream,
          async close() { stream.destroy(); }
        });
      }
    }),
    async close() {}
  });
}

async function createPersistentWebRuntime(
  source: Readonly<Record<string, string | undefined>>
): Promise<WebApiRuntime> {
  const { createProductionWebRuntime } = await import("@/lib/web/production-runtime");
  const runtime = createProductionWebRuntime(source);
  try {
    await runtime.readiness();
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    role: "web" as const,
    authority: "postgres" as const,
    jobs: runtime.jobs,
    files: runtime.files,
    close: runtime.close
  });
}

/**
 * The first resolution is serialized. A failed promise remains rejected until
 * process restart, which is the fail-closed policy and prevents runtime fallback.
 */
export function createRoleAwareWebRuntimeResolver(
  options: CreateRoleAwareWebRuntimeResolverOptions
): RoleAwareWebRuntimeResolver {
  let runtimePromise: Promise<WebApiRuntime> | null = null;

  function resolve(): Promise<WebApiRuntime> {
    if (!runtimePromise) {
      runtimePromise = Promise.resolve().then(async () => {
        const source = options.source();
        const role = parseApplicationProcessRole(source);
        if (role === "local") {
          return (options.createLocal ?? createLocalWebRuntime)();
        }
        if (role === "web") {
          return (options.createWeb ?? createPersistentWebRuntime)(source);
        }
        throw new TypeError(`APP_PROCESS_ROLE=${role} cannot serve HTTP routes.`);
      });
    }
    return runtimePromise;
  }

  async function close(): Promise<void> {
    if (!runtimePromise) return;
    const pending = runtimePromise;
    runtimePromise = null;
    await pending.then((runtime) => runtime.close()).catch(() => undefined);
  }

  return Object.freeze({ resolve, close });
}

const processWebRuntime = createRoleAwareWebRuntimeResolver({ source: () => process.env });

export const resolveWebApiRuntime = processWebRuntime.resolve;
export const closeWebApiRuntime = processWebRuntime.close;
