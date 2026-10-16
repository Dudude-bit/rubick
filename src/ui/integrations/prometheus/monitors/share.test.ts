/**
 * The Monitors screen and its detail panel are bespoke, drawn by a ladder and
 * a set of steps rather than by `page-kit`'s `TroubleList`, so nothing wires
 * them into Share automatically. These hold the section builders; the
 * `useShareSection` calls in `Monitors.tsx` and `Detail.tsx` are not
 * rendered here.
 */

import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { MonitorRow } from "./model";
import { ladderSection, ladderUnread, monitorDetailSections } from "./share";

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

const READ = { unread: null, partial: null };

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
    const section = ladderSection([broken, healthy], READ, t);

    expect(section).not.toBeNull();
    if (section === null || section.body.type !== "findings")
      throw new Error("expected a findings section");
    expect(section.body.items).toHaveLength(2);
    const [brokenFinding] = section.body.items;
    expect(brokenFinding.title).toBe("down-svc");
    expect(brokenFinding.role).toBe("err");
    expect(brokenFinding.ref?.kind).toBe("ServiceMonitor");
  });

  /**
   * A cluster with no monitors and a read that never landed were the same
   * file: no section, and "everything was read". Read and empty says so.
   */
  it("says a read list is empty, rather than leaving the section out", () => {
    const section = ladderSection([], READ, t);
    expect(section.count).toBe(0);
    expect(section.unread ?? null).toBeNull();
    expect(section.body).toMatchObject({ type: "findings", items: [] });
  });

  /** A refused kind is named above the rows that were read, and no total is given. */
  it("names a kind the cluster refused and gives no total", () => {
    const partial = "PodMonitor objects could not be read: forbidden";
    const section = ladderSection([row()], { unread: null, partial }, t);
    expect(section.partial).toBe(partial);
    expect(section.count).toBeNull();
  });

  it("says the monitors were not read when nothing came back", () => {
    const section = ladderSection(
      null,
      { unread: "forbidden", partial: null },
      t
    );
    expect(section.unread).toBe("forbidden");
  });
});

describe("what the ladder could not see", () => {
  const kind = (state: "read" | "unread" | "absent") =>
    state === "read"
      ? { state, items: [] }
      : state === "unread"
        ? { state, reason: "forbidden" }
        : { state };

  /**
   * A 403 on PodMonitors drops that kind from the rows without a trace; the
   * page names it above them, and the file has to as well.
   */
  it("names each kind the cluster refused", () => {
    const said = ladderUnread(
      {
        data: {
          serviceMonitors: kind("read"),
          podMonitors: kind("unread"),
        } as never,
        error: null,
      },
      t
    );
    expect(said.unread).toBeNull();
    expect(said.partial).toContain("PodMonitor");
  });

  it("says the picture is still being read before it lands", () => {
    expect(ladderUnread({ data: undefined, error: null }, t).unread).toBe(
      t("share", "stillReading")
    );
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
