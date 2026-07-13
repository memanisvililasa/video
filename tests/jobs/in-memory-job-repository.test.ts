import { createInMemoryJobRepository } from "@/lib/jobs/in-memory-job-repository";
import { runJobRepositoryContract } from "@/tests/jobs/job-repository.contract";

runJobRepositoryContract("in-memory", () => {
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  return {
    repository: createInMemoryJobRepository({
      terminalTtlMs: 60_000,
      now: () => nowMs
    }),
    now: () => nowMs,
    advanceBy(milliseconds: number) {
      nowMs += milliseconds;
    }
  };
});
