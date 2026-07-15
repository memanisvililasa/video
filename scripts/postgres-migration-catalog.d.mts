export type PostgresMigrationCatalogEntry = Readonly<{
  version: string;
  file: string;
  checksum: string;
}>;

export const POSTGRES_MIGRATION_CATALOG: readonly PostgresMigrationCatalogEntry[];
