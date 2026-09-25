/**
 * The Alerts screen is drawn by its own ladder, not `page-kit`'s
 * `TroubleList`, so nothing wires it into Share automatically. Delete
 * `alertsSection` or its `useShareSection` call in `Alerts.tsx` and this
 * fails.
 */

import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { RuleRow } from "./model";
import { alertsSection, rulesUnread } from "./share";

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

describe("rules the ladder does not draw green register with Share", () => {
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
    const section = alertsSection([firing, pending, quiet], null, t);

    expect(section).not.toBeNull();
    if (section === null || section.body.type !== "findings")
      throw new Error("expected a findings section");
    expect(section.body.items).toHaveLength(2);
    const [first] = section.body.items;
    expect(first.title).toBe("disk-space");
    expect(first.role).toBe("err");
    expect(first.ref?.kind).toBe("PrometheusRule");
  });

  /** The tab's own count says "2 broken" in red; the file left both out,
   *  and filed a rule nobody could check under nothing to report. */
  it("reports broken rule objects as errors and unchecked ones as unknown", () => {
    const section = alertsSection(
      [row({ group: "broken" }), row({ group: "unchecked" }), row()],
      null,
      t
    );
    if (section === null || section.body.type !== "findings")
      throw new Error("expected a findings section");
    expect(section.body.items.map((item) => item.role)).toEqual([
      "err",
      "neutral",
    ]);
  });

  /** Rules never read returned no section, which the file shows as nothing
   *  firing; a refusal and a load still running are said apart. */
  it("marks the section unread when the rules were refused or not read yet", () => {
    const refused = rulesUnread(
      { rules: { state: "unread", reason: "prometheusrules is forbidden" } },
      null,
      t
    );
    expect(refused).toBe("prometheusrules is forbidden");
    expect(alertsSection(null, refused, t)?.unread).toBe(
      "prometheusrules is forbidden"
    );
    expect(rulesUnread(undefined, null, t)).toBe(
      "Still being read when the report was made."
    );
    expect(rulesUnread(undefined, new Error("timed out"), t)).toContain(
      "timed out"
    );
  });

  /** A cluster that does not serve PrometheusRule has none, honestly. */
  it("reports nothing where the rule kind is not served", () => {
    expect(rulesUnread({ rules: { state: "absent" } }, null, t)).toBeNull();
  });

  it("reports nothing when every rule object is quiet, not an empty section", () => {
    expect(alertsSection([row(), row()], null, t)).toBeNull();
    expect(alertsSection(null, null, t)).toBeNull();
  });
});
