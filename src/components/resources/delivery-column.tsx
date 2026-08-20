/**
 * The `Delivery` column, and the filter that is the real reason it exists.
 *
 * There is deliberately **no "managed" mark**. On a cluster Argo or Flux runs,
 * every row would carry one; the column earns its width by being empty for the
 * ordinary row and saying something only where there is something to say.
 *
 * The filter is where "being delivered" pays off even when it is not worth
 * marking: *show me what Argo does not own* is how you find the thing somebody
 * applied by hand at three in the morning and never wrote down, and it costs
 * nothing on screen until it is used.
 */

import { createContext, useContext, type ReactNode } from "react";

import type { Delivery } from "@/integrations";
import { delivered, type DeliveryFilter } from "@/lib/delivery";
import { cn } from "@/lib/utils";
import { DeliveryCell } from "./delivery";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

const DeliveryRows = createContext<((row: unknown) => Delivery[]) | null>(null);

export function DeliveryRowsProvider({
  of,
  children,
}: {
  of: (row: unknown) => Delivery[];
  children: ReactNode;
}) {
  return <DeliveryRows.Provider value={of}>{children}</DeliveryRows.Provider>;
}

/**
 * The cell, which reads the page's one answer rather than asking for its own.
 *
 * The whole page's objects are resolved in a single read and handed to every
 * cell through a context; a cell that asked on its own behalf would turn one
 * call into five hundred.
 */
export function DeliveryColumnCell({ row }: { row: unknown }) {
  const of = useContext(DeliveryRows);
  return <DeliveryCell deliveries={of?.(row) ?? []} />;
}

const OPTIONS: Array<{ id: DeliveryFilter; label: keyof typeof en.action }> = [
  { id: "all", label: "all" },
  { id: "notDelivered", label: "notDelivered" },
  { id: "trouble", label: "needsAttention" },
];

/**
 * Three answers, and one caveat stated where it would otherwise look like a
 * bug.
 *
 * A controller that publishes no per-object comparison can never put a row
 * behind "Needs attention" for drift, however far its objects have wandered —
 * so on a cluster it runs, that filter looks broken rather than empty. It is
 * named from the data rather than from a list of vendors: any delivery
 * controller that reports `sync: null` says so here, including one written
 * after this file.
 */
export function DeliveryFilterControl({
  value,
  onChange,
  deliveries,
}: {
  value: DeliveryFilter;
  onChange: (value: DeliveryFilter) => void;
  deliveries: Delivery[][];
}) {
  const t = useT();
  const blind = [
    ...new Set(
      deliveries
        .flatMap((entry) => delivered(entry))
        .filter((source) => source.sync === null)
        .map((source) => source.vendor)
    ),
  ];

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-[10px] uppercase tracking-[0.08em] text-fg-fnt">
        {t("columns", "delivery")}
      </span>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            "text-[11px] transition-colors",
            option.id === value ? "text-fg" : "text-fg-fnt hover:text-fg-mut"
          )}
        >
          {t("action", option.label)}
        </button>
      ))}
      {value === "trouble" && blind.length > 0 && (
        <span className="text-[11px] text-fg-fnt">
          {t("empty", "blindReconcilers", {
            n: blind.length,
            vendors: blind.join(` ${t("empty", "listAnd")} `),
          })}
        </span>
      )}
    </div>
  );
}
