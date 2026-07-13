import { describe, expect, it } from "vitest";
import {
  PostgresMediaArtifactRowError,
  postgresRowToMediaArtifact,
  type PostgresMediaArtifactRow
} from "@/lib/storage/postgres/artifact-row-mapper";

function validRow(): PostgresMediaArtifactRow {
  return {
    artifact_id: `file_${"a".repeat(32)}`,
    job_id: "job_artifact_mapper",
    attempt_id: `attempt_${"b".repeat(32)}`,
    kind: "final",
    publication_state: "published",
    storage_key: `published/aa/aa/file_${"a".repeat(32)}.mp4`,
    filename: "safe.mp4",
    content_type: "video/mp4",
    byte_size: "42",
    checksum_sha256: "c".repeat(64),
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:01.000Z"),
    published_at: new Date("2026-01-01T00:00:01.000Z"),
    expires_at: new Date("2026-01-01T01:00:00.000Z"),
    version: "2"
  };
}

describe("PostgreSQL artifact row mapper", () => {
  it("returns a frozen application record", () => {
    const mapped = postgresRowToMediaArtifact(validRow());
    expect(mapped).toMatchObject({ artifactId: `file_${"a".repeat(32)}`, sizeBytes: 42, version: 2 });
    expect(Object.isFrozen(mapped)).toBe(true);
  });

  it.each([
    { publication_state: "public" },
    { kind: "source" },
    { storage_key: "../../secret" },
    { byte_size: "NaN" },
    { checksum_sha256: "bad" },
    { published_at: null },
    { expires_at: "not-a-date" },
    { filename: "../secret" }
  ])("fails closed for malformed row %#", (change) => {
    expect(() => postgresRowToMediaArtifact({ ...validRow(), ...change })).toThrow(PostgresMediaArtifactRowError);
  });
});
