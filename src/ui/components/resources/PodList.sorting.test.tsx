import { describe, expect, it } from "vitest";
import type { ColumnDef } from "@/components/ui/table-features";

import { columns } from "./PodList";

/**
 * Which pod columns sort, and by what.
 *
 * Requested in #107: "especially in Pods, because you often need to sort by
 * status or by restart count".
 *
 * A column sorts on the value its `accessorFn` returns, not on what the cell
 * draws, so the accessor is the thing worth pinning: it is invisible on
 * screen and wrong sorting looks like no sorting at all.
 */
type Row = {
  status: { display: string; phase: string };
  restartCount: number;
  containers?: unknown[];
};

// `ColumnDef` is a union — the accessor arm carries `accessorFn` and the
// display arm does not — so reading it needs the narrowing the union exists
// to force, done once here.
type WithAccessor = { accessorFn?: (row: Row, index: number) => unknown };

const column = (id: string) => {
  const found = (columns as ColumnDef<Row>[]).find((c) => c.id === id);
  if (!found) throw new Error(`the pod list has no ${id} column`);
  return found as ColumnDef<Row> & WithAccessor;
};

const valueOf = (id: string, row: Row) => {
  const accessor = column(id).accessorFn;
  if (typeof accessor !== "function") {
    throw new Error(`the ${id} column has no accessor to sort by`);
  }
  return accessor(row, 0);
};

describe("the pod columns a reader can sort", () => {
  /** By the word on screen, not the phase behind it: they sort this to bring
   *  the crashing pods together, and a pod that has crashed six hundred times
   *  is in phase `Running`. */
  it("sorts status by the derived word rather than the phase", () => {
    expect(
      valueOf("status", {
        status: { display: "CrashLoopBackOff", phase: "Running" },
        restartCount: 653,
      })
    ).toBe("CrashLoopBackOff");
  });

  it("sorts restarts by the count", () => {
    expect(
      valueOf("restarts", {
        status: { display: "Running", phase: "Running" },
        restartCount: 653,
      })
    ).toBe(653);
  });

  /** By what is missing, so the ones short of a replica sort together
   *  regardless of how many they were asked for. */
  it("sorts ready by the shortfall, not by the ready count", () => {
    const short = valueOf("ready", {
      status: { display: "Running", phase: "Running" },
      restartCount: 0,
      containers: [],
    });
    expect(typeof short).toBe("number");
  });

  /** A header that offers to sort a column with nothing to sort by does
   *  nothing when pressed, which is worse than not offering. */
  it("offers sorting only on the columns that declared an accessor", () => {
    for (const c of columns as ColumnDef<Row>[]) {
      if (c.enableSorting) {
        const declared = c as ColumnDef<Row> & WithAccessor;
        expect(
          typeof declared.accessorFn === "function" || "accessorKey" in c,
          `${c.id} offers sorting with nothing to sort by`
        ).toBe(true);
      }
    }
  });
});
