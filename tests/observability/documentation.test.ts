import { describe, expect, it } from "vitest";
// @ts-expect-error Documentation verifier is intentionally plain Node.js ESM.
import { verifyObservabilityDocumentation } from "../../scripts/verify-observability-documentation.mjs";

describe("Stage 5 observability operator documentation", () => {
  it("keeps alerts, dashboards, runbooks, journald, cutover, and rollback fail closed", async () => {
    await expect(verifyObservabilityDocumentation()).resolves.toEqual({
      alerts: 24,
      runbooks: 18,
      dashboardSections: 13
    });
  });
});
