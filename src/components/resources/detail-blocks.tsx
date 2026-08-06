import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { UnitValue } from "@/components/ui/metric-value";
import { eventReasonMark } from "@/lib/event-reason";
import { formatCPU, formatMemory } from "@/lib/k8s-quantity";
import { usageRole } from "@/lib/metric-format";
import { cn, formatDate } from "@/lib/utils";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { ResourceRef } from "./ResourceRef";
import { TONE_CLASS, type KeyValueTone } from "./key-values";
import type { ConditionInfo, EventInfo } from "@/generated/types";

/**
 * The blocks a resource detail page repeats: an action in the header row, a
 * condition list, a headroom bar and an event feed. All flat, all built from
 * role tokens, all sharing the column rhythm the overview and the event
 * screen already use. Cross-references to other objects are `ResourceRef`.
 */

export interface DetailActionProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "disabled" | "type"
> {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  /** Spins the icon and blocks the click while a mutation is in flight. */
  busy?: boolean;
  /** Destructive actions read in the error colour; the word still says it. */
  danger?: boolean;
  /**
   * Why the action cannot run on this object. Unlike `disabled` the control
   * stays focusable and hoverable, so whatever describes it — a tooltip on
   * the trigger — is reachable rather than sitting on a dead element.
   */
  reason?: string | null;
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
  reason,
  className,
  ...rest
}: DetailActionProps) {
  const blocked = !!reason;
  // A tooltip or a menu mounts this through Radix's `asChild`, which merges
  // its own handlers in as props. Overwriting `onClick` outright would drop
  // them, so the forwarded one is called alongside ours.
  const { onClick: forwarded, ...attributes } =
    rest as ButtonHTMLAttributes<HTMLButtonElement>;

  return (
    <button
      {...attributes}
      type="button"
      onClick={(event) => {
        forwarded?.(event);
        if (!blocked) onClick();
      }}
      disabled={!blocked && (disabled || busy)}
      aria-disabled={blocked || undefined}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded px-1.5 text-[11px] transition-colors disabled:pointer-events-none disabled:opacity-40",
        danger ? "text-err" : "text-fg-mut",
        blocked
          ? "cursor-default opacity-40"
          : cn("hover:bg-hover", !danger && "hover:text-fg"),
        className
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

export type CompositionTone = "ok" | "warn" | "err" | "neutral";

export interface CompositionSegment {
  label: string;
  count: number;
  tone: CompositionTone;
}

const SEGMENT_BAR: Record<CompositionTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  neutral: "bg-fg-fnt",
};

/** Only the abnormal segments carry colour; the healthy majority stays quiet. */
const SEGMENT_LEGEND: Record<CompositionTone, string> = {
  ok: "text-fg-fnt",
  warn: "text-warn",
  err: "text-err",
  neutral: "text-fg-fnt",
};

export interface CompositionProps {
  /**
   * The denominator the segments partition. `null` when the list was
   * refused: a count that cannot be read must not draw an empty bar, which
   * is the picture of "nothing here".
   */
  total: number | null;
  label: string;
  segments: CompositionSegment[];
  /** Legend text when the total is real but nothing is in it. */
  emptyMessage?: ReactNode;
  /** Why the total is what it is, e.g. "2 at a time · up to 6 retries". */
  note?: ReactNode;
}

/**
 * One count, split into what it is made of.
 *
 * A rollout is a single fact — "6 wanted, 5 running, 1 still coming" — and
 * printing desired/current/ready/updated/available as five equal rows made
 * the reader do the subtraction. The bar does it: the segments partition the
 * total, so a gap is visible before any number is read. The overview's
 * per-kind census is the same shape and shares this component.
 */
export function Composition({
  total,
  label,
  segments,
  emptyMessage = "nothing scheduled",
  note,
}: CompositionProps) {
  const visible = segments.filter((segment) => segment.count > 0);

  return (
    <div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={cn(
            "font-mono text-[15px] font-semibold",
            total == null ? "text-fg-fnt" : "text-fg"
          )}
        >
          {total ?? "—"}
        </span>
        <span className="text-[11px] text-fg-mut">{label}</span>
      </div>
      <div className="mb-1.5 mt-[7px] flex h-[3px] overflow-hidden rounded-sm bg-sel">
        {total != null &&
          visible.map((segment) => (
            <span
              key={segment.label}
              className={SEGMENT_BAR[segment.tone]}
              style={{ flex: segment.count }}
            />
          ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {total == null ? (
          <span className="text-fg-fnt">not readable with this access</span>
        ) : visible.length === 0 ? (
          <span className="text-fg-fnt">{emptyMessage}</span>
        ) : (
          visible.map((segment) => (
            <span key={segment.label} className={SEGMENT_LEGEND[segment.tone]}>
              {segment.count} {segment.label}
            </span>
          ))
        )}
      </div>
      {note && <p className="mt-1.5 text-[11px] text-fg-fnt">{note}</p>}
    </div>
  );
}

export interface HeadlineProps {
  label: string;
  value: ReactNode;
  /** One line under the value: the human reading of it, or why it is absent. */
  note?: ReactNode;
  mono?: boolean;
  tone?: KeyValueTone;
}

/**
 * The fact a page exists to answer, at the size of a composition's number.
 *
 * A cron schedule buried as row nine of a twenty-row metadata block is the
 * thing the reader opened the page for. Three of these across the top say it
 * before anything else is read.
 */
export function Headline({ label, value, note, mono, tone }: HeadlineProps) {
  return (
    <div>
      <div className="text-[11px] text-fg-mut">{label}</div>
      <div
        className={cn(
          "mt-1 break-words text-[15px] font-semibold",
          mono && "font-mono",
          tone ? TONE_CLASS[tone] : "text-fg"
        )}
      >
        {value}
      </div>
      {note && <p className="mt-0.5 text-[11px] text-fg-fnt">{note}</p>}
    </div>
  );
}

/**
 * Severity, reason, who it happened to, how often, how long ago. Exported
 * because the `/events` screen builds its skeleton rows on the same grid.
 */
export const EVENT_ROW =
  "grid grid-cols-[10px_minmax(0,182px)_minmax(0,1fr)_54px_44px] items-baseline gap-2.5 px-1.5 py-[3px] text-xs";

/** The same feed at drawer width, where the reason column would eat the
 *  message — which is the part being read there. Both widths carry the
 *  14px the family glyph and its gap cost, so the reason truncates no
 *  earlier than it did before the glyph existed. */
const EVENT_ROW_COMPACT =
  "grid grid-cols-[10px_minmax(0,106px)_minmax(0,1fr)_38px_30px] items-baseline gap-2 py-[3px] text-xs";

export interface EventRowsProps {
  events: EventInfo[];
  emptyMessage?: ReactNode;
  /** Off when every row is the same object and naming it would be noise. */
  showObject?: boolean;
  /** Off when the whole feed is already scoped to one namespace. */
  showNamespace?: boolean;
  /** Narrow columns, for the peek panel's 440px. */
  compact?: boolean;
}

/** The event feed. Used whole-cluster on `/events` and scoped on a detail. */
export function EventRows({
  events,
  emptyMessage = "No events for this object",
  showObject = false,
  showNamespace = false,
  compact = false,
}: EventRowsProps) {
  if (events.length === 0) {
    return (
      <p className={cn("py-1 text-xs text-fg-fnt", !compact && "px-1.5")}>
        {emptyMessage}
      </p>
    );
  }
  return (
    <div>
      {events.map((event) => (
        <EventRow
          key={event.uid}
          event={event}
          showObject={showObject}
          showNamespace={showNamespace}
          compact={compact}
        />
      ))}
    </div>
  );
}

function EventRow({
  event,
  showObject,
  showNamespace,
  compact,
}: {
  event: EventInfo;
  showObject: boolean;
  showNamespace: boolean;
  compact: boolean;
}) {
  const isWarning = event.type === "Warning";
  const age = useRealtimeAge(event.lastTimestamp ?? null);
  const count = event.count ?? 0;
  const { family, Icon, color } = eventReasonMark(event.reason ?? null);
  // Two independent channels, one per column: the mark on the left is
  // severity and only severity, the mark on the reason is family and only
  // family. Where they meet, severity takes the colour outright — a Warning
  // is amber end to end or a reader cannot count the warnings in a feed —
  // and the family keeps its shape, which is the whole point of the shapes
  // differing. So a FailedMount is an amber platter and a FailedScheduling
  // an amber pin: still one severity, still two families.
  const familyStyle = isWarning || !color ? undefined : { color };

  return (
    <div className={compact ? EVENT_ROW_COMPACT : EVENT_ROW}>
      {/* Shape carries the severity alongside the colour — the feed has to
       *  stay readable without hue. */}
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
          "inline-flex min-w-0 items-baseline gap-1 font-mono font-medium",
          isWarning ? "text-warn" : familyStyle ? undefined : "text-fg-mut"
        )}
        style={familyStyle}
      >
        <span className="sr-only">
          {event.type}
          {family ? `, ${family}` : ""}:{" "}
        </span>
        <Icon
          className="h-2.5 w-2.5 flex-none self-center"
          aria-hidden="true"
        />
        <span className="truncate">{event.reason ?? "—"}</span>
      </span>
      <span className="truncate text-fg-mid">
        {showObject && (
          <ResourceRef
            kind={event.involvedObject.kind}
            name={event.involvedObject.name}
            namespace={event.involvedObject.namespace ?? event.namespace}
          />
        )}
        {showNamespace && event.namespace && (
          <span className="text-fg-fnt"> · {event.namespace}</span>
        )}
        {event.message && (
          <span className="text-fg-fnt">
            {showObject ? " — " : ""}
            {event.message}
          </span>
        )}
      </span>
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
