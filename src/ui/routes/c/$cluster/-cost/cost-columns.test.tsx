import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { AppColumnMeta } from "@/components/ui/table-features";
import { workloadColumns } from "./cost-columns";

const t: T = (section, key, values) => translate("en", section, key, values);

const row = (name: string) =>
  ({
    key: { namespace: "audit-test", group: "apps", kind: "Deployment", name },
    pods: 1,
    perHour: null,
    atLeast: false,
    parts: {},
    unpriced: ["cpu", "memory"],
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
    for (const kept of ["workload", "perHour", "efficiency"])
      expect(yields[kept], kept).toBeUndefined();
    expect(yields.memoryRequested!).toBeLessThan(yields.memoryUsed!);
    expect(yields.cpuRequested!).toBeLessThan(yields.cpuUsed!);
    expect(yields.cpuUsed!).toBeLessThan(yields.namespace!);
  });
});
