/**
 * The Monitors screen and its detail panel are bespoke, drawn by a ladder and
 * a set of steps rather than by `page-kit`'s `TroubleList`, so nothing wires
 * them into Share automatically. Delete either `useShareSection` call in
 * `Monitors.tsx` or `Detail.tsx`, or the section builders they call, and
 * these fail.
 */

import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { MonitorRow } from "./model";
import { ladderSection, monitorDetailSections } from "./share";

const t: T = (section, key, values) => translate("en", section, key, values);

function row(overrides: Partial<MonitorRow> = {}): MonitorRow {
  return {
    monitor: {
      kind: "ServiceMonitor",
      name: "web",
      namespace: "shop",
      uid: "shop/ServiceMonitor/web",
      labels: {},
      selector: null,
      namespaceSelector: null,
      endpoints: [{ port: "http", path: "/metrics", interval: "30s" }],
    },
    selected: { kind: "services", names: ["shop/web"] },
    pickedUp: { state: "judged", by: ["shop/prom"] },
    scrape: {
      state: "read",
      targets: [],
      up: 1,
      down: 0,
      unknown: 0,
      lastError: null,
      lastScrape: null,
    },
    findings: [],
    worst: null,
    ...overrides,
  } as unknown as MonitorRow;
}

describe("the monitor ladder registers itself with Share", () => {
  it("gives every monitor a finding with the row's own role, sentence and ref", () => {
    const broken = row({
      monitor: {
        kind: "ServiceMonitor",
        name: "down-svc",
        namespace: "shop",
      } as MonitorRow["monitor"],
      worst: "err",
      findings: [
        {
          kind: "targetsDown",
          severity: "err",
          down: 2,
          total: 2,
          lastError: "connection refused",
        },
      ],
    });
    const healthy = row();
    const section = ladderSection([broken, healthy], t);

    expect(section).not.toBeNull();
    if (section === null || section.body.type !== "findings")
      throw new Error("expected a findings section");
    expect(section.body.items).toHaveLength(2);
    const [brokenFinding] = section.body.items;
    expect(brokenFinding.title).toBe("down-svc");
    expect(brokenFinding.role).toBe("err");
    expect(brokenFinding.ref?.kind).toBe("ServiceMonitor");
  });

  it("reports nothing for a screen with no monitors, not an empty section", () => {
    expect(ladderSection([], t)).toBeNull();
    expect(ladderSection(null, t)).toBeNull();
  });
});

describe("a monitor's own detail registers its facts and its targets", () => {
  it("puts the endpoints, who picked it up and the verdict into facts", () => {
    const [facts] = monitorDetailSections(row(), { head: "Scraping fine" }, t);
    if (facts.body.type !== "facts") throw new Error("expected facts");
    const labels = facts.body.rows.map((entry) => entry.label);
    expect(labels).toContain(t("monitors", "endpoints"));
    const pickedUp = facts.body.rows.find(
      (entry) => entry.label === t("monitors", "pickedUpBy")
    );
    expect(pickedUp?.values[0].text).toBe("shop/prom");
  });

  /** A monitor nobody has picked up is a finding, not a blank row. */
  it("says so when nothing has picked the monitor up", () => {
    const [facts] = monitorDetailSections(
      row({ pickedUp: { state: "judged", by: [] } }),
      { head: "x" },
      t
    );
    if (facts.body.type !== "facts") throw new Error("expected facts");
    const pickedUp = facts.body.rows.find(
      (entry) => entry.label === t("monitors", "pickedUpBy")
    );
    expect(pickedUp?.values[0].text).toBe(t("monitors", "notPickedUp"));
    expect(pickedUp?.values[0].role).toBe("err");
  });

  /** A refused scrape read is not the same claim as zero targets. */
  it("marks the targets table unread when Prometheus never answered", () => {
    const [, targets] = monitorDetailSections(
      row({
        scrape: {
          state: "unanswered",
          reason: "timed out",
        } as MonitorRow["scrape"],
      }),
      { head: "x" },
      t
    );
    expect(targets.unread).toContain("timed out");
    if (targets.body.type !== "table") throw new Error("expected a table");
    expect(targets.body.rows).toEqual([]);
  });

  it("lists every target's health, url and last error in the table", () => {
    const [, targets] = monitorDetailSections(
      row({
        scrape: {
          state: "read",
          targets: [
            {
              scrapePool: "pool",
              scrapeUrl: "http://10.0.0.1:9090/metrics",
              health: "down",
              lastError: "connection refused",
              lastScrape: null,
              labels: {},
            },
          ],
          up: 0,
          down: 1,
          unknown: 0,
          lastError: "connection refused",
          lastScrape: null,
        } as MonitorRow["scrape"],
      }),
      { head: "x" },
      t
    );
    if (targets.body.type !== "table") throw new Error("expected a table");
    expect(targets.body.rows).toHaveLength(1);
    expect(targets.body.rows[0].cells[0]).toMatchObject({
      text: "down",
      role: "err",
    });
  });
});
