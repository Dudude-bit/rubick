import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { UnitValue } from "@/components/ui/metric-value";
import { conditionRole } from "@/lib/condition-health";
import { eventReasonMark } from "@/lib/event-reason";
import type { MessageSubject } from "@/lib/message-refs";
import { formatQuantity, usageRole } from "@/lib/metric-format";
import { ROLE_ICON, ROLE_TEXT } from "@/lib/status-role";
import { cn, formatDate } from "@/lib/utils";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { ResourceMessage } from "./ResourceMessage";
import { ResourceRef } from "./ResourceRef";
import { TONE_CLASS, type KeyValueTone } from "./key-values";
import type { ConditionInfo, EventInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

/**
 * The blocks a resource detail page repeats: an action in the header row, a
 * condition list, a headroom bar and an event feed. Flat, role tokens only,
 * on the column rhythm the overview and the event screen already use.
 * Cross-references to other objects are `ResourceRef`.
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
 * 190px is `PodReadyToStartContainers` — the longest condition name a pod has
 * — in the 12px mono face with a character to spare. A CRD can still invent
 * something longer, so the `title` stays.
 */
const CONDITION_ROW =
  "grid items-baseline gap-2.5 px-1.5 py-[3px] text-xs grid-cols-[10px_minmax(0,190px)_58px_minmax(0,1fr)_46px]";

/**
 * The same row with the trailing age column taken out — see `ConditionRows`
 * for when it is not there to take out.
 */
const CONDITION_ROW_UNDATED =
  "grid items-baseline gap-2.5 px-1.5 py-[3px] text-xs grid-cols-[10px_minmax(0,190px)_58px_minmax(0,1fr)]";

export function ConditionRows({
  conditions,
  emptyMessage,
  subject,
}: {
  conditions: ConditionInfo[];
  emptyMessage?: string;
  /**
   * The object these conditions belong to. A controller writes about its own
   * namespace without naming it — `ReplicaSet "x" has timed out progressing`
   * — so without this the names in a condition stay text.
   */
  subject?: MessageSubject;
}) {
  if (conditions.length === 0) {
    return (
      <p className="px-1.5 py-1 text-xs text-fg-fnt">
        {emptyMessage ?? <T section="empty" k="noConditions" />}
      </p>
    );
  }
  // A pod's conditions carry no message at all — that is the whole list on
  // every healthy pod — so its age column would be a strip of numbers at the
  // far right of a quarter-width of nothing. When no row here has a sentence
  // to print, every age moves into the sentence's place and the column goes.
  const dated = conditions.some((c) => c.message || c.reason);
  return (
    <div>
      {conditions.map((condition) => (
        <ConditionRow
          key={`${condition.type}/${condition.lastTransitionTime ?? ""}`}
          condition={condition}
          subject={subject}
          dated={dated}
        />
      ))}
    </div>
  );
}

function ConditionRow({
  condition,
  subject,
  dated,
}: {
  condition: ConditionInfo;
  subject?: MessageSubject;
  /** Whether the list reserved a trailing column for the transition time. */
  dated: boolean;
}) {
  const role = conditionRole(condition);
  // Colour is spent on anomalies only: five of a pod's six conditions are
  // satisfied on every healthy pod, and five green ticks per row is the wall
  // of colour that makes the sixth invisible. A satisfied condition keeps its
  // glyph and gives up its hue, as the composition bar's healthy segment
  // does, but not its hierarchy — three greys stand in: the type at full
  // strength, whatever it has to say a step under, the status word and the
  // time under that. An anomaly takes the role colour back on the type and
  // the status word.
  const satisfied = role === "ok";
  const tone = satisfied ? "text-fg-mut" : ROLE_TEXT[role];
  const Icon = ROLE_ICON[role];
  const age = useRealtimeAge(condition.lastTransitionTime ?? null);
  const stamp = formatDate(condition.lastTransitionTime) ?? undefined;
  const detail = condition.message || condition.reason;
  // The one fact a satisfied condition's glyph has not already given: since
  // when. It reads on from the status word — `Ready True for 3d` — so it takes
  // the sentence's place, and the row has no second place to print it.
  const held = !detail && condition.lastTransitionTime;

  return (
    <div className={dated ? CONDITION_ROW : CONDITION_ROW_UNDATED}>
      {/* The five marks differ in outline as well as hue, so a condition
       *  list on a broken node still separates unreadable from failed for a
       *  reader who cannot use the colour. */}
      <Icon
        className={cn("h-2.5 w-2.5 justify-self-center self-center", tone)}
        aria-hidden="true"
        data-testid="condition-icon"
      />
      <span
        className={cn(
          "truncate font-mono font-medium",
          satisfied ? "text-fg" : tone
        )}
        title={condition.type}
      >
        {condition.type}
      </span>
      {/* Kept next to the glyph that already said "met" because for a
       *  `MemoryPressure` the word that means met is `False`, and the reader
       *  with `kubectl describe` open beside this needs to see which. */}
      <span
        className={cn("truncate text-[11px]", satisfied ? "text-fg-fnt" : tone)}
      >
        {condition.status}
      </span>
      <span className="truncate text-fg-mut">
        {condition.reason && detail !== condition.reason && (
          <span className="font-mono">{condition.reason} </span>
        )}
        {detail && <ResourceMessage message={detail} subject={subject} />}
        {held && (
          <span className="text-fg-fnt" title={stamp}>
            <T section="count" k="heldFor" values={{ age }} />
          </span>
        )}
      </span>
      {dated && (
        <span className="text-right text-[11px] text-fg-fnt" title={stamp}>
          {detail && condition.lastTransitionTime ? age : ""}
        </span>
      )}
    </div>
  );
}

export interface ProblemSummaryProps {
  /** What is wrong, as a sentence in the reader's terms. */
  headline: ReactNode;
  /** The cluster's own word for it, and what that word means. */
  detail?: ReactNode;
  /** The way to the tab that holds the rest of it. */
  action?: ReactNode;
  tone?: "err" | "warn";
}

/**
 * Why this object is not doing its job, at the top of the page.
 *
 * Above the tab strip, so the reason is on every tab rather than on the one
 * the reader happens to guess.
 *
 * Deliberately not a banner: no fill, no border, no icon in a box. The glyph
 * and the colour are the same two channels the condition rows and the event
 * feed already use for "this one is bad".
 */
export function ProblemSummary({
  headline,
  detail,
  action,
  tone = "err",
}: ProblemSummaryProps) {
  const color = tone === "err" ? "text-err" : "text-warn";
  return (
    <div className="flex items-start gap-2">
      <span className={cn("mt-[3px] text-[9px]", color)} aria-hidden="true">
        ▲
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-[13px] font-semibold tracking-tight", color)}>
          {headline}
        </p>
        {detail && (
          <p className="mt-0.5 wrap-break-word text-xs text-fg-mut">{detail}</p>
        )}
        {/* Under its own sentence, not flushed to the far edge of a 1160px
         *  row: a link that far from the reason it belongs to reads as one
         *  of the page's actions rather than the way to the rest of this
         *  one. */}
        {action && (
          <div className="-ml-1.5 mt-0.5 flex items-center">{action}</div>
        )}
      </div>
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

const BAR_ROLE = { ok: "bg-info", warn: "bg-warn", err: "bg-err" } as const;

/**
 * How much of a ceiling is in use, as the mock's pressure row: a name, a 5px
 * track and the ratio. Below the warning threshold the fill stays informational
 * rather than green — a bar at 30% is not an achievement worth colouring.
 */
export function UsageRow({ label, used, total, type, unit }: UsageRowProps) {
  const t = useT();
  const usedNum = typeof used === "number" ? used : null;
  const totalNum = typeof total === "number" && total > 0 ? total : null;
  const ratio =
    usedNum !== null && totalNum !== null ? usedNum / totalNum : null;

  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-center gap-3 px-1.5 py-1">
      <span className="text-[11px] text-fg-mut">{label}</span>
      {/* No track without a ratio to fill it. An empty full-width track
       *  reads as a bar at zero, and neither "declares no limit" nor "no
       *  metrics-server" is a reading of 0%. */}
      {ratio === null ? (
        <span />
      ) : (
        <span className="relative h-[5px] overflow-hidden rounded-[3px] bg-sel">
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-[3px]",
              BAR_ROLE[usageRole(ratio)]
            )}
            style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
          />
        </span>
      )}
      <span className="text-right text-[11px] text-fg-mut">
        {usedNum === null ? (
          // A blank number here is almost never "this object uses
          // nothing" — it is metrics-server not being installed, which
          // is a cluster the reader can fix rather than a reading.
          <span
            className="text-fg-fnt"
            title={t("empty", "metricsServerNotReporting")}
          >
            {t("empty", "noMetricsServer")}
          </span>
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
 * The segments partition the total, so a gap in a rollout is visible before
 * any number is read — desired/current/ready/updated/available as five equal
 * rows left the subtraction to the reader. The overview's per-kind census is
 * the same shape and shares this component.
 */
export function Composition({
  total,
  label,
  segments,
  emptyMessage,
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
          <span className="text-fg-fnt">
            {emptyMessage ?? <T section="empty" k="nothingScheduled" />}
          </span>
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
 * Three of these across the top say what the reader opened the page for — a
 * cron schedule, say — before the metadata block is reached.
 */
export function Headline({ label, value, note, mono, tone }: HeadlineProps) {
  return (
    <div>
      <div className="text-[11px] text-fg-mut">{label}</div>
      <div
        className={cn(
          "mt-1 wrap-break-word text-[15px] font-semibold",
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
  emptyMessage,
  showObject = false,
  showNamespace = false,
  compact = false,
}: EventRowsProps) {
  if (events.length === 0) {
    return (
      <p className={cn("py-1 text-xs text-fg-fnt", !compact && "px-1.5")}>
        {emptyMessage ?? <T section="empty" k="noEventsForObject" />}
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
  // Almost every name a controller writes is in its own namespace and it
  // does not say so; the involved object is the one thing that knows which.
  const subject = {
    kind: event.involvedObject.kind,
    name: event.involvedObject.name,
    namespace: event.involvedObject.namespace ?? event.namespace,
  };
  // Two independent channels, one per column: the left mark is severity, the
  // mark on the reason is family. Where they meet severity takes the colour
  // outright — a Warning is amber end to end or the warnings in a feed cannot
  // be counted — and the family keeps only its shape, so a FailedMount is an
  // amber platter and a FailedScheduling an amber pin.
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
            kind={subject.kind}
            name={subject.name}
            namespace={subject.namespace}
          />
        )}
        {showNamespace && event.namespace && (
          <span className="text-fg-fnt"> · {event.namespace}</span>
        )}
        {event.message && (
          <span className="text-fg-fnt">
            {showObject ? " — " : ""}
            <ResourceMessage message={event.message} subject={subject} />
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
