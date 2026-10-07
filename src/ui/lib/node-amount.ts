import type { BudgetUnit, ResourceQuantities } from "@/generated/types";
import {
  formatBytes,
  formatCPU,
  formatCores,
  parseQuantity,
} from "@/lib/k8s-quantity";

/** A node resource's figure, written the one way the node page and its peek write it. */
export function nodeAmount(
  unit: BudgetUnit,
  value: number,
  cores = false
): string {
  switch (unit) {
    case "cpu":
      return cores ? formatCores(value) : formatCPU(value);
    case "memory":
      return formatBytes(value, { trim: true });
    case "count":
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

/** The four resources every kubelet reports, under the names it reports them. */
export const NODE_RESOURCES = [
  { name: "cpu", key: "cpu", unit: "cpu" },
  { name: "memory", key: "memory", unit: "memory" },
  { name: "pods", key: "pods", unit: "count" },
  { name: "ephemeral-storage", key: "ephemeralStorage", unit: "memory" },
] as const satisfies ReadonlyArray<{
  name: string;
  key: keyof ResourceQuantities;
  unit: BudgetUnit;
}>;

/** A CPU row holding a whole core anywhere is written in cores in every cell. */
export function inCores(
  unit: BudgetUnit,
  values: ReadonlyArray<number | null>
): boolean {
  return (
    unit === "cpu" && values.some((value) => value !== null && value >= 1000)
  );
}

/** Quantities as the kubelet wrote them, read into the page's figures; one kept as written where it does not parse. */
export function nodeQuantities(
  unit: BudgetUnit,
  raws: ReadonlyArray<string | null>
): Array<string | null> {
  const values = raws.map((raw) => {
    const parsed = raw === null ? null : parseQuantity(raw);
    return parsed === null ? null : unit === "cpu" ? parsed * 1000 : parsed;
  });
  const cores = inCores(unit, values);
  return raws.map((raw, i) => {
    const value = values[i];
    return value === null || value === undefined
      ? raw
      : nodeAmount(unit, value, cores);
  });
}
