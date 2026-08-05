import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

import { UnitValue } from "@/components/ui/metric-value";
import { formatCPU, formatMemory } from "@/lib/k8s-quantity";
import { usageRole } from "@/lib/metric-format";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import type { ResourceKind } from "@/lib/resource-registry";
import { cn, formatDate } from "@/lib/utils";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import type { ConditionInfo, EventInfo } from "@/generated/types";

/**
 * The blocks a resource detail page repeats: a link to another object, an
 * action in the header row, a condition list, a headroom bar and an event
 * feed. All flat, all built from role tokens, all sharing the column rhythm
 * the overview and the event screen already use.
 */

export interface ResourceLinkProps {
  kind: ResourceKind | string;
  name: string;
  namespace?: string | null;
  /** Appended after the name, e.g. a port. Not part of the identifier. */
  suffix?: string;
  className?: string;
}

/** A cross-reference to another object. Mono, because it is a name. */
export function ResourceLink({
  kind,
  name,
  namespace,
  suffix,
  className,
}: ResourceLinkProps) {
  return (
    <Link
      to={getResourceDetailUrl(kind, name, namespace)}
      className={cn("font-mono text-info hover:underline", className)}
    >
      {name}
      {suffix && <span className="text-fg-fnt">:{suffix}</span>}
    </Link>
  );
}

export interface DetailActionProps {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  /** Spins the icon and blocks the click while a mutation is in flight. */
  busy?: boolean;
  /** Destructive actions read in the error colour; the word still says it. */
  danger?: boolean;
}

/**
 * One item in the detail header's action row.
 *
 * Text with an icon, not a boxed button: the canvas has no surfaces, and four
 * outlined buttons above a page of hairlines were the heaviest thing on it.
 */
export function DetailAction({
  label,
  icon: Icon,
  onClick,
  disabled,
  busy,
  danger,
}: DetailActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded px-1.5 text-[11px] transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40",
        danger ? "text-err" : "text-fg-mut hover:text-fg"
      )}
    >
      {Icon && <Icon className={cn("h-3.5 w-3.5", busy && "animate-spin")} />}
      {label}
    </button>
  );
}

/**
 * Conditions whose healthy value is `False`.
 *
 * A node reports pressure by setting the condition True, which is the exact
 * opposite of the Ready-style conditions. Colouring on the status word alone
 * painted a perfectly healthy node's `MemoryPressure=False` red.
 */
const HEALTHY_WHEN_FALSE = new Set([
  "memorypressure",
  "diskpressure",
  "pidpressure",
  "networkunavailable",
  "replicafailure",
  "failed",
  "failuretarget",
]);

type ConditionVerdict = "good" | "unknown" | "bad";

function conditionVerdict(condition: ConditionInfo): ConditionVerdict {
  const status = condition.status.toLowerCase();
  if (status !== "true" && status !== "false") return "unknown";
  const healthyValue = HEALTHY_WHEN_FALSE.has(
    condition.type.toLowerCase().replace(/[\s_-]/g, "")
  )
    ? "false"
    : "true";
  return status === healthyValue ? "good" : "bad";
}

const VERDICT_TONE: Record<ConditionVerdict, string> = {
  good: "text-fg-mut",
  unknown: "text-warn",
  bad: "text-err",
};

const VERDICT_GLYPH: Record<ConditionVerdict, string> = {
  good: "●",
  unknown: "▲",
  bad: "▲",
};

const CONDITION_ROW =
  "grid grid-cols-[10px_minmax(0,140px)_58px_minmax(0,1fr)_46px] items-baseline gap-2.5 px-1.5 py-[3px] text-xs";

export function ConditionRows({
  conditions,
  emptyMessage = "No conditions reported",
}: {
  conditions: ConditionInfo[];
  emptyMessage?: string;
}) {
  if (conditions.length === 0) {
    return <p className="px-1.5 py-1 text-xs text-fg-fnt">{emptyMessage}</p>;
  }
  return (
    <div>
      {conditions.map((condition) => (
        <ConditionRow
          key={`${condition.type}/${condition.lastTransitionTime ?? ""}`}
          condition={condition}
        />
      ))}
    </div>
  );
}

function ConditionRow({ condition }: { condition: ConditionInfo }) {
  const verdict = conditionVerdict(condition);
  const tone = VERDICT_TONE[verdict];
  const age = useRealtimeAge(condition.lastTransitionTime ?? null);
  const detail = condition.message || condition.reason;

  return (
    <div className={CONDITION_ROW}>
      {/* The glyph differs in shape as well as colour: a condition list is
       *  the first thing read on a broken node, and hue alone would not
       *  survive a colour deficiency. */}
      <span
        className={cn("justify-self-center text-[9px]", tone)}
        aria-hidden="true"
      >
        {VERDICT_GLYPH[verdict]}
      </span>
      <span className={cn("truncate font-mono font-medium", tone)}>
        {condition.type}
      </span>
      <span className={cn("truncate text-[11px]", tone)}>
        {condition.status}
      </span>
      <span className="truncate text-fg-mid">
        {condition.reason && detail !== condition.reason && (
          <span className="font-mono text-fg-mut">{condition.reason} </span>
        )}
        <span className="text-fg-fnt">{detail ?? "—"}</span>
      </span>
      <span
        className="text-right text-[11px] text-fg-fnt"
        title={formatDate(condition.lastTransitionTime) ?? undefined}
      >
        {condition.lastTransitionTime ? age : "—"}
      </span>
    </div>
  );
}

export interface UsageRowProps {
  label: string;
  /** Millicores for `cpu`, bytes for `memory`, a plain count for `count`. */
  used: number | null | undefined;
  /** The denominator. Without one there is no bar to draw. */
  total: number | null | undefined;
  type: "cpu" | "memory" | "count";
  /** Unit suffix for `count`, e.g. " pods". */
  unit?: string;
}

function formatQuantity(
  value: number,
  type: UsageRowProps["type"],
  unit?: string
): string {
  if (type === "cpu") return formatCPU(value);
  if (type === "memory")
    return formatMemory(value, 1).replace(/\.0(?=\D|$)/, "");
  return `${Math.round(value)}${unit ?? ""}`;
}

const BAR_ROLE = { ok: "bg-info", warn: "bg-warn", err: "bg-err" } as const;

/**
 * How much of a ceiling is in use, as the mock's pressure row: a name, a 5px
 * track and the ratio. Below the warning threshold the fill stays informational
 * rather than green — a bar at 30% is not an achievement worth colouring.
 */
export function UsageRow({ label, used, total, type, unit }: UsageRowProps) {
  const usedNum = typeof used === "number" ? used : null;
  const totalNum = typeof total === "number" && total > 0 ? total : null;
  const ratio =
    usedNum !== null && totalNum !== null ? usedNum / totalNum : null;

  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-center gap-3 px-1.5 py-1">
      <span className="text-[11px] text-fg-mut">{label}</span>
      <span className="relative h-[5px] overflow-hidden rounded-[3px] bg-sel">
        {ratio !== null && (
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-[3px]",
              BAR_ROLE[usageRole(ratio)]
            )}
            style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
          />
        )}
      </span>
      <span className="text-right text-[11px] text-fg-mut">
        {usedNum === null ? (
          <span className="text-fg-fnt">no metrics</span>
        ) : (
          <UnitValue value={formatQuantity(usedNum, type, unit)} />
        )}
        {totalNum !== null && (
          <>
            <span className="text-[0.85em] text-fg-fnt">/</span>
            <UnitValue value={formatQuantity(totalNum, type, unit)} />
            {ratio !== null && (
              <>
                {" · "}
                {Math.round(ratio * 100)}
                <span className="text-[0.85em] text-fg-fnt">%</span>
              </>
            )}
          </>
        )}
      </span>
    </div>
  );
}

const EVENT_ROW =
  "grid grid-cols-[10px_minmax(0,168px)_minmax(0,1fr)_54px_44px] items-baseline gap-2.5 px-1.5 py-[3px] text-xs";

/** The event feed's row, scoped to one object. Same rhythm as `/events`. */
export function EventRows({
  events,
  emptyMessage = "No events for this object",
}: {
  events: EventInfo[];
  emptyMessage?: string;
}) {
  if (events.length === 0) {
    return <p className="px-1.5 py-1 text-xs text-fg-fnt">{emptyMessage}</p>;
  }
  return (
    <div>
      {events.map((event) => (
        <EventRow key={event.uid} event={event} />
      ))}
    </div>
  );
}

function EventRow({ event }: { event: EventInfo }) {
  const isWarning = event.type === "Warning";
  const age = useRealtimeAge(event.lastTimestamp ?? null);
  const count = event.count ?? 0;

  return (
    <div className={EVENT_ROW}>
      <span
        className={cn(
          "justify-self-center text-[9px]",
          isWarning ? "text-warn" : "text-fg-fnt"
        )}
        aria-hidden="true"
      >
        {isWarning ? "▲" : "●"}
      </span>
      <span
        className={cn(
          "truncate font-mono font-medium",
          isWarning ? "text-warn" : "text-fg-mut"
        )}
      >
        <span className="sr-only">{event.type}: </span>
        {event.reason ?? "—"}
      </span>
      <span className="truncate text-fg-fnt">{event.message}</span>
      <span className="text-right font-mono text-[11px] text-fg-fnt">
        {count > 1 ? `×${count}` : ""}
      </span>
      <span
        className="text-right text-[11px] text-fg-fnt"
        title={formatDate(event.lastTimestamp) ?? undefined}
      >
        {event.lastTimestamp ? age : "—"}
      </span>
    </div>
  );
}
