export type MigrationOptions = Readonly<{
  connectionString: string;
  sslMode?: string;
  nodeEnv?: string;
  schema?: string;
}>;

export function applyMigrations(
  options: MigrationOptions
): Promise<Readonly<{ total: number; applied: readonly string[] }>>;

export function migrationStatus(
  options: MigrationOptions
): Promise<readonly Readonly<{ version: string; status: "applied" | "pending" }>[]>;
