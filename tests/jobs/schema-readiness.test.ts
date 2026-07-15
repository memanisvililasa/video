import { describe, expect, it } from "vitest";
import {
  assertPostgresSchemaCompatible,
  assertProductionWebSchemaCompatible,
  assertProductionWorkerSchemaCompatible
} from "@/lib/jobs/postgres/schema-readiness";

describe("canonical production schema readiness", () => {
  it("uses one exact compatibility implementation for web and worker", () => {
    expect(assertProductionWebSchemaCompatible).toBe(assertPostgresSchemaCompatible);
    expect(assertProductionWorkerSchemaCompatible).toBe(assertPostgresSchemaCompatible);
  });
});
