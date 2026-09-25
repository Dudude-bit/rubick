/**
 * The Alerts screen is drawn by its own ladder, not `page-kit`'s
 * `TroubleList`, so nothing wires it into Share automatically. Delete
 * `alertsSection` or its `useShareSection` call in `Alerts.tsx` and this
 * fails.
 */

import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { RuleRow } from "./model";
import { alertsSection } from "./share";

const t = ((
  section: never,
  key: never,
  values?: Record<string, string | number>
) => translate("en", section, key, values)) as never;

function row(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    object: {
      name: "disk-space",
      namespace: "monitoring",
      uid: "monitoring/PrometheusRule/disk-space",
      labels: {},
      rules: [],
      recording: 0,
    },
    pickedUp: { state: "judged", by: ["monitoring/prom"] },
    loaded: { state: "read", files: [], rules: [] },
    findings: [],
    group: "quiet",
    ...overrides,
  } as unknown as RuleRow;
}

describe("firing and pending rules register with Share", () => {
  it("reports a finding per firing or pending rule object, skipping the quiet ones", () => {
    const firing = row({
      group: "firing",
      findings: [{ kind: "firing", severity: "err", alerts: 3, rules: 1 }],
    });
    const pending = row({
      object: {
        name: "cpu-hot",
        namespace: "monitoring",
        uid: "monitoring/PrometheusRule/cpu-hot",
        labels: {},
        rules: [],
        recording: 0,
      },
      group: "pending",
    });
    const quiet = row();
    const section = alertsSection([firing, pending, quiet], t);

    expect(section).not.toBeNull();
    if (section === null || section.body.type !== "findings")
      throw new Error("expected a findings section");
    expect(section.body.items).toHaveLength(2);
    const [first] = section.body.items;
    expect(first.title).toBe("disk-space");
    expect(first.role).toBe("err");
    expect(first.ref?.kind).toBe("PrometheusRule");
  });

  it("reports nothing when every rule object is quiet, not an empty section", () => {
    expect(alertsSection([row(), row()], t)).toBeNull();
    expect(alertsSection(null, t)).toBeNull();
  });
});
