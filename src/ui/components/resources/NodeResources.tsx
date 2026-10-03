import { Section, SectionHeader } from "@/components/ui/section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatCPU } from "@/lib/k8s-quantity";
import { cn } from "@/lib/utils";
import type { NodeBudget, ResourceBudget } from "@/generated/types";
import { useT } from "@/i18n/useT";

/** Usage the node itself reported, where a source exists for the resource. */
export interface NodeUsage {
  cpuMillicores: number | null;
  memoryBytes: number | null;
}

interface NodeResourcesProps {
  budget: NodeBudget | undefined;
  /** The read failed outright; the table then says so instead of drawing. */
  error: string | null;
  onRetry: () => void;
  usage: NodeUsage | null;
  /** Pods on the node as counted, for the row the budget cannot fill alone. */
  podsRunning: number | null;
}

function amount(unit: ResourceBudget["unit"], value: number): string {
  switch (unit) {
    case "cpu":
      return formatCPU(value);
    case "memory":
      return formatBytes(value, 1);
    case "count":
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

function share(value: number, of: number | null): string | null {
  if (of === null || of <= 0) return null;
  return `${Math.round((value / of) * 100)}%`;
}

/**
 * One table for the machine: what it has, what the kubelet offers, what the
 * scheduler has promised, what the pods may burst to, what is in use.
 *
 * Requested and limited are numbers or the word "unknown", never a sum over
 * the namespaces that could be read: a smaller number presented as the
 * whole is the one thing this table must not say.
 */
export function NodeResources({
  budget,
  error,
  onRetry,
  usage,
  podsRunning,
}: NodeResourcesProps) {
  const t = useT();

  if (error !== null) {
    // Not a table with blanks: a table that could not be read has no rows to
    // be honest about, and a blank cell reads as "nothing here".
    return (
      <Section>
        <SectionHeader title={t("columns", "resources")} />
        <div className="rounded-md border border-dashed border-hair px-3 py-2 text-xs">
          <p className="text-fg-mut">{t("empty", "nodeBudgetQuestion")}</p>
          <p className="mt-1 font-mono text-[11px] text-err">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 text-info hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
          >
            {t("action", "retry")}
          </button>
        </div>
      </Section>
    );
  }

  if (budget === undefined) {
    // Still reading. An empty table here would read as "this node reports no
    // resources", which is an answer we do not have yet.
    return (
      <Section>
        <SectionHeader title={t("columns", "resources")} />
        <p className="px-3 py-2 text-xs text-fg-mut" role="status">
          {t("action", "reading")}
        </p>
      </Section>
    );
  }

  const rows = budget.resources;

  return (
    <Section>
      <SectionHeader
        title={t("columns", "resources")}
        count={t("empty", "nodeResourcesNote")}
      />
      {budget && !budget.known && (
        <p className="mb-2 text-xs text-warn" role="status">
          {budget.error
            ? t("empty", "nodeBudgetFailed", { error: budget.error })
            : t("empty", "nodeBudgetRefused", {
                n: budget.refused.length,
                namespaces: budget.refused.join(", "),
              })}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns", "resource")}</TableHead>
            <TableHead className="text-right">
              {t("columns", "capacity")}
            </TableHead>
            <TableHead className="text-right">
              {t("columns", "allocatable")}
            </TableHead>
            <TableHead className="text-right">
              {t("columns", "requested")}
            </TableHead>
            <TableHead className="text-right">
              {t("columns", "limited")}
            </TableHead>
            <TableHead className="text-right">{t("columns", "used")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const used = usedOf(row, usage, podsRunning);
            return (
              <TableRow key={row.name} data-quiet>
                <TableCell className="font-mono text-xs">
                  {row.name}
                  {row.extended && (
                    <span className="ml-2 text-[11px] text-fg-fnt">
                      {t("columns", "extendedResource")}
                    </span>
                  )}
                </TableCell>
                <Figure unit={row.unit} value={row.capacity} of={null} />
                <Figure unit={row.unit} value={row.allocatable} of={null} />
                <Figure
                  unit={row.unit}
                  value={row.requested}
                  of={row.allocatable}
                  unknown={!budget?.known}
                />
                <Figure
                  unit={row.unit}
                  value={row.limited}
                  of={row.allocatable}
                  unknown={!budget?.known && row.name !== "pods"}
                  dash={row.name === "pods"}
                />
                <Figure
                  unit={row.unit}
                  value={used}
                  of={row.allocatable}
                  noSource={used === null}
                />
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {budget?.known && budget.pods !== null && (
        <p className="mt-2 text-[11px] text-fg-fnt">
          {t("empty", "nodeBudgetRule", { n: budget.pods })}
        </p>
      )}
    </Section>
  );
}

/** What is in use, from the only sources that exist for it. */
function usedOf(
  row: ResourceBudget,
  usage: NodeUsage | null,
  podsRunning: number | null
): number | null {
  switch (row.name) {
    case "cpu":
      return usage?.cpuMillicores ?? null;
    case "memory":
      return usage?.memoryBytes ?? null;
    case "pods":
      return podsRunning;
    default:
      return null;
  }
}

function Figure({
  unit,
  value,
  of,
  unknown = false,
  dash = false,
  noSource = false,
}: {
  unit: ResourceBudget["unit"];
  value: number | null;
  of: number | null;
  unknown?: boolean;
  dash?: boolean;
  noSource?: boolean;
}) {
  const t = useT();
  if (dash) {
    return <TableCell className="text-right text-fg-fnt">–</TableCell>;
  }
  if (unknown) {
    return (
      <TableCell className="text-right text-warn">
        {t("empty", "unknownWord")}
      </TableCell>
    );
  }
  if (value === null) {
    return (
      <TableCell className="text-right text-fg-fnt">
        {noSource ? t("empty", "noUsageSource") : "–"}
      </TableCell>
    );
  }
  const pct = share(value, of);
  return (
    <TableCell className="text-right font-mono tabular-nums">
      {amount(unit, value)}
      {pct && (
        <span
          className={cn(
            "ml-1.5 text-[11px]",
            value > (of ?? 0) ? "text-warn" : "text-fg-fnt"
          )}
        >
          {pct}
        </span>
      )}
    </TableCell>
  );
}
