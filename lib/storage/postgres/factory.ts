import "server-only";
import {
  parseJobRepositoryConfig,
  parseMediaStorageConfig,
  type MediaStorageConfig
} from "@/lib/config/env";
import { getSharedPostgresPool } from "@/lib/jobs/postgres/pool";
import type { FinalPublicationCoordinator, MediaArtifactRepository } from "@/lib/storage/media-artifact-repository";
import { createDurableVolumeStorage, type DurableVolumeStorage } from "@/lib/storage/durable-volume";
import { assertDurableVolumeMarker } from "@/lib/storage/durable-volume-marker";
import { createDurableMediaFileDelivery, type MediaFileDelivery } from "@/lib/storage/file-delivery";
import { createPostgresMediaArtifactRuntime } from "@/lib/storage/postgres/artifact-repository";
import { createMediaStorageReconciler, type MediaStorageReconciler } from "@/lib/storage/reconciliation";

export type ExplicitDurableMediaRuntime = Readonly<{
  config: MediaStorageConfig & Readonly<{ backend: "durable-volume"; root: string }>;
  storage: DurableVolumeStorage["storage"];
  inventory: DurableVolumeStorage["inventory"];
  health: DurableVolumeStorage["health"];
  artifacts: MediaArtifactRepository;
  publication: FinalPublicationCoordinator;
  delivery: MediaFileDelivery;
  reconciler: MediaStorageReconciler;
  readiness: () => Promise<void>;
  close: () => Promise<void>;
}>;

/**
 * Explicit Phase A construction only. Importing or constructing this factory
 * does not touch the filesystem or database; readiness is the startup boundary.
 * The current API route and local execution queue do not import this module.
 */
export function createExplicitDurableMediaRuntime(
  source: Readonly<Record<string, string | undefined>>,
  options: Readonly<{ postgresSchema?: string; reconciliationGraceMs?: number }> = {}
): ExplicitDurableMediaRuntime {
  const repositoryConfig = parseJobRepositoryConfig(source);
  if (repositoryConfig.backend !== "postgres") {
    throw new TypeError("Durable media storage requires the PostgreSQL repository backend.");
  }
  const parsedStorage = parseMediaStorageConfig(source);
  if (parsedStorage.backend !== "durable-volume" || parsedStorage.root === null) {
    throw new TypeError("Explicit durable media runtime requires durable-volume storage.");
  }
  const config = Object.freeze({ ...parsedStorage, backend: "durable-volume" as const, root: parsedStorage.root });
  const postgres = getSharedPostgresPool(repositoryConfig.postgres, { schema: options.postgresSchema });
  const volume = createDurableVolumeStorage({
    root: config.root,
    maxJobBytes: config.maxJobBytes,
    maxOutputBytes: config.maxOutputBytes,
    lowDiskBytes: config.lowDiskBytes
  });
  const postgresArtifacts = createPostgresMediaArtifactRuntime({ pool: postgres.pool });
  const delivery = createDurableMediaFileDelivery({ artifacts: postgresArtifacts.artifacts, storage: volume.storage });
  const reconciler = createMediaStorageReconciler({
    artifacts: postgresArtifacts.artifacts,
    storage: volume.storage,
    inventory: volume.inventory,
    batchSize: config.cleanupBatchSize,
    orphanGraceMs: options.reconciliationGraceMs
  });
  return Object.freeze({
    config,
    storage: volume.storage,
    inventory: volume.inventory,
    health: volume.health,
    artifacts: postgresArtifacts.artifacts,
    publication: postgresArtifacts.publication,
    delivery,
    reconciler,
    async readiness() {
      await postgres.readiness();
      await assertDurableVolumeMarker(config.root);
      await volume.storage.initialize();
      await volume.health.check();
    },
    close: postgres.close
  });
}
