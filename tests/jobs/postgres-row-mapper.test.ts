import { describe, expect, it } from "vitest";
import {
  postgresRowToMediaJobRecord,
  PostgresRowMappingError,
  POSTGRES_JOB_JSON_MAX_BYTES,
  type PostgresMediaJobRow
} from "@/lib/jobs/postgres/row-mapper";
import { API_ERROR_CODES } from "@/lib/types";

function queuedRow(overrides: Partial<PostgresMediaJobRow> = {}): PostgresMediaJobRow {
  return {
    job_id: "job_mapper",
    status: "queued",
    progress: 0,
    processing_preset: "original",
    source_metadata: null,
    final_result_metadata: null,
    canonical_error: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    started_at: null,
    completed_at: null,
    expires_at: null,
    cancellation_requested_at: null,
    retry_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    version: "1",
    ...overrides
  };
}

describe("PostgreSQL media job row mapper", () => {
  it("normalizes timestamps, bigint versions and returns a frozen independent record", () => {
    const source = {
      sourceId: "source_mapper",
      filename: "source.mp4",
      sizeBytes: 10,
      contentType: "video/mp4",
      registeredAt: "2026-01-01T00:00:01.000Z"
    };
    const row = queuedRow({
      status: "running",
      started_at: new Date("2026-01-01T00:00:00.500Z"),
      source_metadata: source,
      version: "2"
    });
    const record = postgresRowToMediaJobRecord(row);
    source.filename = "mutated.mp4";
    expect(record).toMatchObject({
      status: "running",
      startedAt: "2026-01-01T00:00:00.500Z",
      sourceMetadata: { filename: "source.mp4" },
      version: 2
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.sourceMetadata)).toBe(true);
  });

  it.each([
    ["unknown status", { status: "claimed" }],
    ["unknown preset", { processing_preset: "fast" }],
    ["NaN progress", { progress: Number.NaN }],
    ["infinite progress", { progress: Number.POSITIVE_INFINITY }],
    ["invalid timestamp", { created_at: "not-a-date" }],
    ["numeric timestamp", { created_at: 1_767_225_600_000 }],
    ["negative retry count", { retry_count: -1 }],
    ["zero application version", { version: "0" }],
    ["unsafe lease owner", { lease_owner: "../../worker", lease_expires_at: new Date() }]
  ])("rejects %s", (_name, overrides) => {
    expect(() => postgresRowToMediaJobRecord(queuedRow(overrides))).toThrow(
      PostgresRowMappingError
    );
  });

  it("rejects oversized JSONB before it can reach a serializer", () => {
    expect(() =>
      postgresRowToMediaJobRecord(
        queuedRow({ source_metadata: { padding: "x".repeat(POSTGRES_JOB_JSON_MAX_BYTES) } })
      )
    ).toThrow(PostgresRowMappingError);
  });

  it("revalidates canonical errors instead of trusting stored messages", () => {
    expect(() =>
      postgresRowToMediaJobRecord(
        queuedRow({
          status: "failed",
          started_at: new Date("2026-01-01T00:00:01.000Z"),
          completed_at: new Date("2026-01-01T00:00:02.000Z"),
          expires_at: new Date("2026-01-01T01:00:02.000Z"),
          canonical_error: {
            code: API_ERROR_CODES.PROCESSING_FAILED,
            message: "database-controlled message"
          },
          version: "3"
        })
      )
    ).toThrow(PostgresRowMappingError);
  });
});
