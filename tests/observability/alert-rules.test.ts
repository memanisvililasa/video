import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERT_RULES,
  validateAlertRules,
  validateAlertThresholdOverrides,
  type AlertRuleDefinition
} from "@/lib/observability/alert-rules";

describe("vendor-neutral Phase A alert definitions", () => {
  it("validates unique bounded definitions and resolves every runbook slug", async () => {
    expect(() => validateAlertRules()).not.toThrow();
    const runbooks = await readFile(path.join(process.cwd(), "docs/operations/runbooks.md"), "utf8");
    for (const rule of ALERT_RULES) expect(runbooks).toContain(`## ${rule.runbookSlug}`);
    expect(ALERT_RULES.map((rule) => rule.name)).toEqual(expect.arrayContaining([
      "PostgreSQLUnavailable", "DurableVolumeUnavailable", "WebUnavailable", "QueueDepthHigh", "RetryExhaustion", "MaintenanceStale"
    ]));
    expect(JSON.stringify(ALERT_RULES)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(ALERT_RULES)).not.toMatch(/credential|password|token/i);
  });

  it("rejects duplicate, invalid severity, duration, bounds and unsupported signals", () => {
    const first = ALERT_RULES[0];
    expect(() => validateAlertRules([first, first])).toThrow(/duplicated/);
    const mutate = (changes: Partial<AlertRuleDefinition>) => ({ ...first, ...changes } as AlertRuleDefinition);
    expect(() => validateAlertRules([mutate({ severity: "critical" as never })])).toThrow(/severity/);
    expect(() => validateAlertRules([mutate({ durationSeconds: -1 })])).toThrow(/duration/);
    expect(() => validateAlertRules([mutate({ signal: "job_id" as never })])).toThrow(/unsupported/);
    expect(() => validateAlertRules([mutate({ defaultThreshold: -1 })])).toThrow(/threshold/);
    expect(() => validateAlertRules([mutate({ overrideBounds: { minimum: 10, maximum: 1 } })])).toThrow(/bounds/);
    expect(validateAlertThresholdOverrides({ QueueDepthHigh: 250 })).toEqual({ QueueDepthHigh: 250 });
    expect(() => validateAlertThresholdOverrides({ UnknownRule: 1 })).toThrow(/unknown/);
    expect(() => validateAlertThresholdOverrides({ QueueDepthHigh: 100_000 })).toThrow(/bounded/);
  });
});
