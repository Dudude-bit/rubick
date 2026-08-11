/**
 * Quantity rendering for table cells.
 *
 * A Kubernetes table is a wall of numbers that all look alike. Two devices
 * pull the important part forward: the unit suffix drops to 85% and to the
 * faintest foreground so the digits hold the eye, and a 56x5 bar sits after
 * the number when a limit is known, so "is this close to the edge" is
 * answered without reading a percentage.
 */
import { cn } from "@/lib/utils";
import { formatCPU, formatMemory } from "@/lib/k8s-quantity";
import { splitUnit, usageRole, type UsageRole } from "@/lib/metric-format";

/**
 * Two decimals turn a column of memory into "320.00Ki, 336.00Ki" — noise
 * that reads as precision. One decimal separates any two pods worth
 * separating, and a trailing `.0` carries nothing.
 */
function formatUsage(value: number, type: "cpu" | "memory"): string {
  if (type === "cpu") return formatCPU(value);
  return formatMemory(value, 1).replace(/\.0(?=\D|$)/, "");
}

const BAR_ROLE: Record<UsageRole, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
};

export interface UnitValueProps {
  /** An already-formatted quantity, e.g. "999m" or "1.81Gi". */
  value: string;
  className?: string;
}

/** A quantity with its unit suffix dimmed and shrunk. */
export function UnitValue({ value, className }: UnitValueProps) {
  const { value: head, unit } = splitUnit(value);
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {head}
      {unit && <span className="text-[0.85em] text-fg-fnt">{unit}</span>}
    </span>
  );
}

interface UsageBarProps {
  /** used / limit. Values above 1 are clamped for width, not for colour. */
  ratio: number;
  className?: string;
}

/** The inline fraction-of-limit bar that follows a metric. */
function UsageBar({ ratio, className }: UsageBarProps) {
  const width = Math.min(100, Math.max(0, ratio * 100));
  return (
    <span
      aria-hidden="true"
      className={cn(
        "ml-2 inline-block h-[5px] w-14 overflow-hidden rounded-[3px] bg-sel align-middle",
        className
      )}
    >
      <span
        className={cn("block h-full rounded-[3px]", BAR_ROLE[usageRole(ratio)])}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

export interface MetricValueProps {
  /** Millicores for `cpu`, bytes for `memory`. */
  used: number | null | undefined;
  /** The limit, in the same unit as `used`. Drives the bar. */
  limit?: number | null | undefined;
  /** Shown in the title when there is no limit; never drives the bar. */
  request?: number | null | undefined;
  type: "cpu" | "memory";
  className?: string;
}

/**
 * A metric cell: the number with a dimmed unit, plus a bar when a limit
 * exists. Without a limit there is no denominator worth drawing — a bar
 * against the request would imply a ceiling the pod does not have.
 */
export function MetricValue({
  used,
  limit,
  request,
  type,
  className,
}: MetricValueProps) {
  const usedNum = typeof used === "number" ? used : null;
  if (usedNum === null) return <span className="text-fg-fnt">-</span>;

  const limitNum = typeof limit === "number" && limit > 0 ? limit : null;
  const requestNum =
    typeof request === "number" && request > 0 ? request : null;
  const ratio = limitNum !== null ? usedNum / limitNum : null;

  const display = formatUsage(usedNum, type);
  const title =
    ratio !== null
      ? `${display} / ${formatUsage(limitNum!, type)} limit (${Math.round(ratio * 100)}%)`
      : requestNum !== null
        ? `${display} · ${formatUsage(requestNum, type)} requested, no limit`
        : `${display} · no limit`;

  return (
    <span
      className={cn("inline-flex items-center whitespace-nowrap", className)}
      title={title}
    >
      <UnitValue value={display} />
      {ratio !== null && <UsageBar ratio={ratio} />}
    </span>
  );
}
