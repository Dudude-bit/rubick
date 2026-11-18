import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { AppColumnMeta } from "@/components/ui/table-features";
import { yieldedColumns } from "@/components/ui/column-shares";
import { columnFloor } from "@/lib/column-label";
import { efficiencyOf } from "@/lib/efficiency";
import { namespaceColumns, workloadColumns } from "./cost-columns";

const t: T = (section, key, values) => translate("en", section, key, values);

const row = (name: string) =>
  ({
    key: { namespace: "audit-test", group: "apps", kind: "Deployment", name },
    pods: 1,
    perHour: null,
    atLeast: false,
    parts: {},
    unpriced: ["cpu", "memory"],
    unknown: [],
    requests: { cpu: 0, memory: 0 },
    id: name,
    crd: undefined,
    currency: "",
    share: null,
    efficiency: {
      cpu: {
        state: "unrequested",
        avg: null,
        peak: 3,
        since: null,
        whole: true,
      },
      memory: {
        state: "unrequested",
        avg: null,
        peak: 3,
        since: null,
        whole: true,
      },
    },
  }) as const;

const floorOf = (id: string, rows: readonly unknown[]) => {
  const column = workloadColumns(t).find((c) => c.id === id)!;
  const floor = (column.meta as AppColumnMeta).floor!;
  return typeof floor === "number" ? floor : floor(t, rows as never, null);
};

describe("the breakdown by workload", () => {
  /**
   * The name was cut to "audit-test/lon…" beside half-empty columns. Its
   * floor holds a long name whole, up to the 31 glyphs a list's name gets.
   */
  it("floors the workload's name at the width of a long name", () => {
    const rows = [row("long-running-deployment-with-a-name")];
    expect(floorOf("workload", rows)).toBeGreaterThanOrEqual(31 * 7.2);
  });

  /**
   * At a 1400 px window, about 1150 px of port, By workload hid five
   * columns (Pods, Share, CPU and memory requested, memory used) while the
   * name, the namespace and the cost stood in wide columns: the Used cells
   * said average and peak on one line, and the name's floor held a kind
   * prefix. Fails if the stand's rows lose more than the two least needed.
   */
  it("keeps all but the two least needed columns at the stand's width", () => {
    const now = Date.now();
    const since = new Date(now - 4 * 60_000).toISOString();
    const MI = 1024 * 1024;
    const stand = [
      ["Deployment", "everything-wrong"],
      ["Deployment", "two-replicas-no-budget"],
      ["Deployment", "three-replicas"],
      ["StatefulSet", "as-root"],
      ["Pod", "lonely"],
    ].map(([kind, name], i) => ({
      ...row(name!),
      key: {
        namespace: i % 2 ? "audit-test" : "live51",
        group: "apps",
        kind: kind!,
        name: name!,
      },
      perHour: 0.00167 + i / 1000,
      parts: { cpu: 0.001, memory: 0.0005 },
      unpriced: [],
      currency: "EUR",
      share: { of: 0.12, atMost: false },
      requests: { cpu: 100, memory: 128 * MI },
      efficiency: {
        cpu: efficiencyOf(100, 3, 9, since, now),
        memory: efficiencyOf(128 * MI, 64 * MI, 99 * MI, since, now),
      },
    }));
    const specs = workloadColumns(t).map((c) => ({
      id: c.id!,
      floor: columnFloor(c, t, stand as never),
      yields: (c.meta as AppColumnMeta).yields,
    }));
    const hidden = yieldedColumns(specs, 1150);
    expect(hidden.length).toBeLessThanOrEqual(2);
    for (const id of hidden)
      expect(["memoryRequested", "cpuRequested"]).toContain(id);
  });

  /**
   * Beside a peek, By workload gave its Namespace column up for width and
   * showed two rows both "Deployment/web", one in live51 and one in shop.
   * What tells a row from another is never given up; the rest scroll.
   * Fails if a narrow port hides a row's name or its namespace.
   */
  it("keeps what tells the rows apart at any width", () => {
    const rows = [
      row("web"),
      { ...row("web"), key: { ...row("web").key, namespace: "live51" } },
    ];
    const namespaces = ["shop", "live51"].map((namespace) => ({
      namespace,
      perHour: 0.01,
      atLeast: false,
      parts: { cpu: 0.01 },
      unpriced: [],
      unknown: [],
      currency: "EUR",
      share: { of: 0.5, atMost: false },
    }));
    for (const [columns, held] of [
      [workloadColumns(t), rows],
      [namespaceColumns(t), namespaces],
    ] as const) {
      const specs = columns.map((c) => ({
        id: c.id!,
        floor: columnFloor(c, t, held as never),
        yields: (c.meta as AppColumnMeta).yields,
      }));
      const hidden = yieldedColumns(specs, 200);
      expect(hidden).not.toContain("workload");
      expect(hidden).not.toContain("namespace");
    }
  });

  /** "CPU nothing requestec": the efficiency cell's widest words must fit its floor. */
  it("floors efficiency at its widest words", () => {
    const words = `${t("cost", "memory")} ${t("cost", "effUnrequested")}`;
    expect(floorOf("efficiency", [row("web")])).toBeGreaterThanOrEqual(
      words.length * 7
    );
  });

  /**
   * As the app's lists do: a floor on every column, then the least needed
   * hidden first, then a scroll. The name, its cost and its efficiency are
   * never hidden.
   */
  it("gives every column a size and a floor, and hides the least needed first", () => {
    const columns = workloadColumns(t);
    for (const column of columns) {
      expect(column.size, column.id).toBeGreaterThan(0);
      expect((column.meta as AppColumnMeta).floor, column.id).toBeDefined();
    }
    const yields = Object.fromEntries(
      columns.map((c) => [c.id, (c.meta as AppColumnMeta).yields])
    );
    for (const kept of ["workload", "namespace", "perHour", "efficiency"])
      expect(yields[kept], kept).toBeUndefined();
    expect(yields.memoryRequested!).toBeLessThan(yields.memoryUsed!);
    expect(yields.cpuRequested!).toBeLessThan(yields.cpuUsed!);
  });
});
