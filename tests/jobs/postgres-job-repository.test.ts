import { describe, expect, it, vi } from "vitest";
import {
  createPostgresJobRepository,
  PostgresJobRepositoryError,
  type PostgresQueryExecutor
} from "@/lib/jobs/postgres/repository";

describe("PostgreSQL JobRepository security boundary", () => {
  it("does not execute SQL for unsafe request job identifiers", async () => {
    const query = vi.fn();
    const repository = createPostgresJobRepository({
      database: { query } as unknown as PostgresQueryExecutor
    });
    const unsafe = "job'; DROP TABLE media_jobs; --";
    await expect(repository.get(unsafe)).resolves.toBeNull();
    await expect(repository.update(unsafe, 1, { type: "start" })).resolves.toEqual({
      outcome: "not-found"
    });
    await expect(repository.requestCancellation(unsafe, 1)).resolves.toEqual({
      outcome: "not-found"
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("replaces driver errors with a stable message without SQL or connection details", async () => {
    const secret = "postgresql://user:password@private.example:5432/video";
    const sql = "SELECT source_metadata FROM media_jobs";
    const database = {
      query: vi.fn().mockRejectedValue(new Error(`${secret} ${sql}`))
    } as unknown as PostgresQueryExecutor;
    const repository = createPostgresJobRepository({ database });
    const failure = repository.list();
    await expect(failure).rejects.toBeInstanceOf(PostgresJobRepositoryError);
    await expect(failure).rejects.toThrow("PostgreSQL job repository operation failed.");
    await expect(failure).rejects.not.toThrow("password");
    await expect(failure).rejects.not.toThrow("source_metadata");
  });
});
