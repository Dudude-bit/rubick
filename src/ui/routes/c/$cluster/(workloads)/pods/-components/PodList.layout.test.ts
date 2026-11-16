import { describe, expect, it } from "vite-plus/test";

import {
  actionsColumnSize,
  yieldedColumns,
} from "@/components/ui/column-shares";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { columnFloor } from "@/lib/column-label";
import type { MetricsAbsence } from "@/lib/metrics-absence";
import { columns } from "./PodList";

const en: T = (section, key, values) => translate("en", section, key, values);

interface Column {
  id?: string;
  accessorKey?: string;
  meta?: { yields?: number };
}

const idOf = (column: Column) => String(column.id ?? column.accessorKey);

const crashing = {
  name: "api-794978b95b-g7jpd",
  status: { display: "Init:CrashLoopBackOff" },
  problem: { tone: "warn", n: 2, title: "migrate" },
  nodeName: "gke-prod-pool-1-a3f9-x2kd",
  restartCount: 85,
};

const notRechecked = {
  ...crashing,
  problem: { ...crashing.problem, stale: { at: 1, refused: true } },
};

const laidOutAt = (
  port: number,
  rows: readonly unknown[],
  absence: MetricsAbsence | null
) => {
  const shown = (columns as Column[]).filter(
    (column) => idOf(column) !== "namespace"
  );
  const specs = [
    ...shown.map((column) => ({
      id: idOf(column),
      floor: columnFloor(column, en, rows, absence),
      yields: column.meta?.yields,
    })),
    { id: "actions", floor: actionsColumnSize(1, 10) },
  ];
  const hidden = yieldedColumns(specs, port);
  const kept = specs.filter((spec) => !hidden.includes(spec.id));
  return {
    hidden,
    kept: kept.map((spec) => spec.id),
    floors: kept.reduce((sum, spec) => sum + spec.floor, 0),
  };
};

describe("the Pods list under a refused metrics read", () => {
  /**
   * Once the pointer left, Node was hidden for the whole refusal: a problem
   * that was not rechecked added its words to the status floor. Fails if the
   * refused, not-rechecked state needs more room than the same problem read
   * fresh, or hides Node where the fresh one keeps it, at the 1040px a 1280
   * window leaves the table.
   */
  it("keeps Node at 1280 where the same problem read fresh keeps it", () => {
    const fresh = laidOutAt(1040, [crashing], null);
    const refused = laidOutAt(1040, [notRechecked], "forbidden");
    expect(fresh.kept).toContain("node");
    expect(refused.kept).toContain("node");
    expect(refused.floors).toBeLessThanOrEqual(fresh.floors);
  });

  /**
   * Beside the peek the table grew a sideways scrollbar and cut Restarts: the
   * floors of Name, Status and Restarts summed past the port. Fails if what
   * stays shown has floors past the 560px the peek leaves, or if Restarts is
   * the column that gives way.
   */
  it("fits what stays shown inside the port beside a peek", () => {
    const beside = laidOutAt(560, [notRechecked], "forbidden");
    expect(beside.floors).toBeLessThanOrEqual(560);
    expect(beside.kept).toEqual(
      expect.arrayContaining(["name", "status", "restarts"])
    );
    expect(beside.hidden).toEqual(expect.arrayContaining(["ip", "node"]));
  });
});
