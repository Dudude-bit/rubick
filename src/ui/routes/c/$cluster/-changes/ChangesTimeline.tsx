import { memo, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Eye,
  Lock,
  Undo2,
} from "lucide-react";
import { RollBackLink } from "./RollBackLink";

import { ResourceRef } from "@/components/object/ResourceRef";
import type { EventInfo, FieldMove } from "@/generated/types";
import {
  canRollBackTo,
  fieldWords,
  gapWords,
  letGoWords,
  revisionBefore,
  rowWords,
  unwatchedWords,
  type ChangeItem,
  type ChangeRow,
  type Comparison,
  type FieldChange,
  type Revision,
} from "@/lib/changes";
import { tallyOf } from "@/lib/event-stories";
import { changesLink } from "@/lib/links";
import { sayWords } from "@/i18n/say";
import { cn, formatWhen } from "@/lib/utils";
import { useT } from "@/i18n/useT";

const clock = (ms: number) => formatWhen(ms, "moment");

/** A row before it is measured; most are one line. */
const ROW_PX = 26;

/** Fields of a change drawn before the rest fold behind their count. */
const FIELDS_SHOWN = 3;

/** How near the end of what was read a reader scrolls before older rows are asked for. */
const NEAR_END = 10;

function keyOf(item: ChangeItem, index: number): string {
  switch (item.kind) {
    case "journal":
    case "event":
      return `${item.kind}:${item.row.id}`;
    case "revision":
      return `revision:${item.revision.id}`;
    case "gap":
    case "watched":
      return `${item.kind}:${item.gap.from}`;
    case "letGo":
      return `letGo:${item.of}`;
    default:
      return `${item.kind}:${item.at ?? "?"}:${index}`;
  }
}

/**
 * The timeline, drawn a screen at a time: it is its own scroller, and only
 * the rows in view are in the document, however many a week holds.
 */
export function ChangesTimeline({
  items,
  since,
  showObject = false,
  onRollback,
  rollbackDenied,
  revisions = NO_REVISIONS,
  fill = false,
  onEnd,
  empty,
}: {
  items: ChangeItem[];
  /** A moment the reader came from; everything after it is marked. */
  since?: number | null;
  /** Name the object on each row, for a page that mixes many. */
  showObject?: boolean;
  /** Offered on every older revision whose template was read. */
  onRollback?: (revision: Revision) => void;
  /** Why the cluster will not take a rollback from this user. */
  rollbackDenied?: string;
  /** The object's revisions, for "roll back to before this" on its changes. */
  revisions?: readonly Revision[];
  /** Take the height a flex parent gives, rather than a box of its own. */
  fill?: boolean;
  /** Asked when the reader nears the last row read: older ones may remain. */
  onEnd?: () => void;
  /** What an empty window says, where the filter has its own words. */
  empty?: string;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    getItemKey: (index) => keyOf(items[index], index),
    overscan: 12,
    // A size before the first measurement: jsdom measures every box as zero.
    initialRect: { width: 800, height: 600 },
    useAnimationFrameWithResizeObserver: true,
  });
  const drawn = virtualizer.getVirtualItems();
  const last = drawn.at(-1)?.index ?? -1;
  useEffect(() => {
    if (onEnd && items.length > 0 && last >= items.length - NEAR_END) onEnd();
  }, [onEnd, last, items.length]);

  if (items.length === 0) {
    return (
      <p className="px-1.5 py-1 text-xs text-fg-fnt">
        {empty ?? t("changes", "nothingInWindow")}
      </p>
    );
  }
  return (
    <div
      ref={scrollRef}
      className={cn(
        "overflow-y-auto scrollbar-lane",
        fill ? "min-h-0 flex-1" : "max-h-[70vh]"
      )}
      data-testid="changes-timeline"
    >
      <ol
        className="relative text-xs"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {drawn.map((virtual) => {
          const item = items[virtual.index];
          const after = since != null && item.at !== null && item.at >= since;
          return (
            <li
              key={virtual.key}
              data-index={virtual.index}
              ref={virtualizer.measureElement}
              className={cn(
                "absolute left-0 top-0 grid w-full grid-cols-[112px_minmax(0,1fr)] items-baseline gap-2 rounded px-1.5 py-1",
                after && "bg-sel/40"
              )}
              style={{ transform: `translateY(${virtual.start}px)` }}
              data-after-since={after ? "true" : undefined}
            >
              <span className="font-mono text-[11px] text-fg-fnt">
                {item.kind === "gap" ||
                item.kind === "watched" ||
                item.kind === "letGo"
                  ? ""
                  : item.at === null
                    ? "?"
                    : clock(item.at)}
              </span>
              <Row
                item={item}
                showObject={showObject}
                onRollback={onRollback}
                rollbackDenied={rollbackDenied}
                revisions={revisions}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const NO_REVISIONS: readonly Revision[] = [];

const Row = memo(function Row({
  item,
  showObject,
  onRollback,
  rollbackDenied,
  revisions,
}: {
  item: ChangeItem;
  showObject: boolean;
  onRollback?: (revision: Revision) => void;
  rollbackDenied?: string;
  revisions: readonly Revision[];
}) {
  const t = useT();
  switch (item.kind) {
    case "gap":
      return (
        <div
          role="note"
          className={cn(
            "rounded border border-dashed px-2 py-1 text-[11px]",
            item.gap.elsewhere
              ? "border-hair text-fg-mut"
              : "border-warn/60 bg-warn/5 text-warn"
          )}
        >
          {gapWords(item.gap, t, clock)}
        </div>
      );
    case "letGo":
      return (
        <div
          role="note"
          className="rounded border border-dashed border-warn/60 bg-warn/5 px-2 py-1 text-[11px] text-warn"
          data-testid="changes-let-go"
        >
          {letGoWords(item, t, clock)}
        </div>
      );
    case "watched": {
      const refused = item.refused && unwatchedWords(item.refused, t, true);
      return (
        <p className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-fg-mut">
          <Eye className="h-3 w-3 flex-none text-fg-fnt" aria-hidden="true" />
          {gapWords(item.gap, t, clock, item.quiet ? "quiet" : "changed")}
          {refused && (
            <span className="inline-flex items-center gap-1 text-warn">
              <Lock className="h-3 w-3 flex-none" aria-hidden="true" />
              {refused}
            </span>
          )}
        </p>
      );
    }
    case "created":
      return (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-fg-mut">
          <CirclePlus className="h-3 w-3 text-fg-fnt" aria-hidden="true" />
          {t("changes", "objectCreated")}
        </p>
      );
    case "revision": {
      const { revision, against } = item;
      return (
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono font-medium text-fg">
              {revision.number !== null
                ? t("changes", "revisionNumber", { n: revision.number })
                : revision.name}
            </span>
            {revision.current ? (
              <span className="rounded bg-ok/15 px-1 text-[10px] text-ok">
                {t("changes", "revisionCurrent")}
              </span>
            ) : null}
            <span className="font-mono text-[11px] text-fg-fnt">
              {revision.name}
            </span>
            {onRollback && canRollBackTo(revision) && (
              <RollBackLink
                onClick={() => onRollback(revision)}
                denied={rollbackDenied}
                className="ml-auto text-[11px]"
              />
            )}
          </div>
          {revision.changeCause ? (
            <p className="text-fg-mut">
              <span className="font-mono text-[11px] text-fg-fnt">
                {t("changes", "changeCause")}
              </span>{" "}
              {revision.changeCause}
            </p>
          ) : null}
          {item.readopted ? (
            <p className="text-[11px] text-warn">{t("changes", "readopted")}</p>
          ) : null}
          {against.state === "compared" && against.missing > 0 ? (
            <p className="text-[11px] text-warn">
              {t("changes", "revisionsMissing", { n: against.missing })}
            </p>
          ) : null}
          <Against against={against} />
        </div>
      );
    }
    case "delivery":
      return (
        <div className="min-w-0">
          <span className="text-fg">
            {t("changes", "delivered", {
              owner: `${item.revision.owner.kind} ${item.revision.owner.name}`,
              revision: item.revision.revision ?? "?",
            })}
          </span>
          {item.revision.from ? (
            <span className="ml-1 text-fg-fnt">
              {t("changes", "deliveredFrom", { from: item.revision.from })}
            </span>
          ) : null}
          {item.revision.status ? (
            <span className="ml-1 font-mono text-[11px] text-fg-mut">
              {item.revision.status}
            </span>
          ) : null}
        </div>
      );
    case "helm": {
      const unread = item.revision.unreadable;
      return (
        <div className="min-w-0">
          <span
            className={unread ? "text-warn" : "text-fg"}
            title={unread ?? undefined}
          >
            {t("changes", "helmRevision", {
              n: item.revision.revision,
              chart: unread
                ? t("empty", "releaseNotRead")
                : item.revision.chart,
            })}
          </span>
          <span className="ml-1 font-mono text-[11px] text-fg-mut">
            {item.revision.status}
          </span>
          {item.revision.description ? (
            <span className="ml-1 text-fg-fnt">
              {item.revision.description}
            </span>
          ) : null}
        </div>
      );
    }
    case "journal":
      return (
        <ChangeLine
          row={item.row}
          showObject={showObject}
          onRollback={onRollback}
          rollbackDenied={rollbackDenied}
          revisions={revisions}
        />
      );
    case "event":
      return <EventLine event={item.event} showObject={showObject} />;
  }
});

function ChangeLine({
  row,
  showObject,
  onRollback,
  rollbackDenied,
  revisions,
}: {
  row: ChangeRow;
  showObject: boolean;
  onRollback?: (revision: Revision) => void;
  rollbackDenied?: string;
  revisions: readonly Revision[];
}) {
  const t = useT();
  const what = row.what;
  const before = revisionBefore(row, revisions);
  // On a page of many objects the dialog lives on the object's own tab:
  // the link opens it marked from this moment.
  const reachBack =
    showObject && what.says === "changed" && what.before !== null
      ? changesLink(
          {
            kind: row.kind,
            name: row.name,
            namespace: row.namespace ?? undefined,
          },
          row.at
        )
      : null;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {showObject ? (
          <ResourceRef
            kind={row.kind}
            group={row.group || undefined}
            name={row.name}
            namespace={row.namespace ?? undefined}
            showNamespace
          />
        ) : null}
        {what.says === "changed" ? null : (
          <span
            className={cn(
              "font-mono text-[11px]",
              what.says === "generation" ? "text-fg-mut" : "text-fg"
            )}
          >
            {rowWords(row, t)}
          </span>
        )}
        {onRollback && before && canRollBackTo(before) && (
          <RollBackLink
            onClick={() => onRollback(before)}
            denied={rollbackDenied}
            label={t("action", "rollBackBefore")}
            className="ml-auto text-[11px]"
          />
        )}
        {reachBack && (
          <Link
            {...reachBack}
            className="ml-auto inline-flex items-center gap-1 rounded text-[11px] text-info hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
          >
            <Undo2 className="h-3 w-3" aria-hidden="true" />
            {t("action", "rollBackBefore")}…
          </Link>
        )}
      </div>
      {what.says === "changed" && (
        <Fields fields={what.fields} more={what.more} />
      )}
      {row.atRelist ? (
        <p className="text-[11px] text-warn">
          {t("changes", "journalSeenAtRelist")}
        </p>
      ) : null}
    </div>
  );
}

/** The first fields of a change, and the rest behind their count. */
function Fields({ fields, more }: { fields: FieldMove[]; more: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const folded = open ? 0 : Math.max(0, fields.length - FIELDS_SHOWN);
  const shown = folded > 0 ? fields.slice(0, FIELDS_SHOWN) : fields;
  return (
    <ul className="mt-0.5 flex flex-col gap-px">
      {shown.map((field) => (
        <li key={field.path} className="font-mono text-[11px] wrap-break-word">
          <FieldLine field={field} />
        </li>
      ))}
      {folded > 0 ? (
        <li>
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1 rounded text-[11px] text-fg-mut hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
          >
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
            {t("changes", "moreFields", { n: folded + more })}
          </button>
        </li>
      ) : more > 0 ? (
        <li className="text-[11px] text-fg-fnt">
          {t("changes", "moreFields", { n: more })}
        </li>
      ) : null}
    </ul>
  );
}

function FieldLine({ field }: { field: FieldMove }) {
  const t = useT();
  if (field.says === "notKept")
    return <span className="text-fg">{fieldWords(field, t)}</span>;
  return (
    <>
      <span className="text-fg">{field.path}</span>{" "}
      <Value value={field.from} className="text-fg-mut" />
      <span className="text-fg-fnt"> → </span>
      <Value value={field.to} className="text-fg" />
    </>
  );
}

/** One series of the cluster's events, in the cluster's own words. */
function EventLine({
  event,
  showObject,
}: {
  event: EventInfo;
  showObject: boolean;
}) {
  const t = useT();
  const warning = event.type === "Warning";
  const tally = tallyOf(event);
  const count = event.count ?? 0;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span
          className={cn("text-[9px]", warning ? "text-warn" : "text-fg-fnt")}
          aria-hidden="true"
        >
          {warning ? "▲" : "●"}
        </span>
        <span className="sr-only">{event.type}</span>
        <span
          className={cn(
            "font-mono text-[11px] font-medium",
            warning ? "text-warn" : "text-fg-mut"
          )}
        >
          {event.reason ?? ""}
        </span>
        {showObject ? (
          <ResourceRef
            kind={event.involvedObject.kind}
            name={event.involvedObject.name}
            namespace={event.involvedObject.namespace ?? undefined}
            showNamespace
          />
        ) : null}
        {count > 1 ? (
          <span
            className="font-mono text-[11px] text-fg-fnt"
            title={tally ? sayWords(tally, t) : undefined}
          >
            ×{count}
          </span>
        ) : null}
      </div>
      {event.message ? (
        <p className="text-[11px] wrap-break-word text-fg-mut">
          {event.message}
        </p>
      ) : null}
    </div>
  );
}

export function Against({ against }: { against: Comparison }) {
  const t = useT();
  if (against.state === "oldest")
    return (
      <p className="text-[11px] text-fg-fnt">
        {t("changes", "revisionOldest")}
      </p>
    );
  if (against.state === "unread")
    return (
      <p className="text-[11px] text-warn">{t("changes", "templateUnread")}</p>
    );
  const { changes, others } = against;
  if (changes.length === 0 && others?.length === 0)
    return (
      <p className="text-[11px] text-fg-fnt">{t("changes", "sameTemplate")}</p>
    );
  return (
    <>
      {changes.length === 0 && others === null && (
        <p className="text-[11px] text-warn">
          {t("changes", "comparedUnchangedRestUnread")}
        </p>
      )}
      {changes.length > 0 && (
        <ul className="mt-0.5 flex flex-col gap-px">
          {changes.map((change, index) => (
            <li key={index} className="font-mono text-[11px]">
              <Field change={change} />
            </li>
          ))}
        </ul>
      )}
      {others && others.length > 0 && <OtherFields others={others} />}
    </>
  );
}

/** Past this, the rest of a large template diff is a count, not a wall. */
const OTHER_FIELDS_SHOWN = 40;

/** Everything else that differs, folded behind the count so the named changes stay the headline. */
function OtherFields({ others }: { others: FieldChange[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mt-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 rounded text-[11px] text-warn hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
      >
        <Chevron className="h-3 w-3" aria-hidden="true" />
        {t("changes", "otherFieldsDiffer", { n: others.length })}
      </button>
      {open && (
        <ul className="mt-0.5 flex flex-col gap-px border-l border-hair pl-2">
          {others.slice(0, OTHER_FIELDS_SHOWN).map((change, index) => (
            <li key={index} className="font-mono text-[11px] wrap-break-word">
              <Field change={change} />
            </li>
          ))}
          {others.length > OTHER_FIELDS_SHOWN && (
            <li className="text-[11px] text-fg-fnt">
              {t("changes", "moreOtherFields", {
                n: others.length - OTHER_FIELDS_SHOWN,
              })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function Field({ change }: { change: FieldChange }) {
  const t = useT();
  const prefix = change.container ? `${change.container} ` : "";
  if (change.field === "container") {
    return (
      <>
        <span className="text-fg-fnt">{t("changes", "fieldContainer")} </span>
        <span className="text-fg">{change.container}</span>{" "}
        <span className="text-fg-mut">
          {change.to === null ? t("changes", "removed") : t("changes", "added")}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="text-fg-fnt">{prefix}</span>
      <span className="text-fg">{change.field}</span>{" "}
      <Value value={change.from} className="text-fg-mut" />
      <span className="text-fg-fnt"> → </span>
      <Value value={change.to} className="text-fg" />
    </>
  );
}

/** A whole volume or a sidecar spec is one value; it is clipped, with the rest on hover. */
const VALUE_CHARS = 120;

function Value({
  value,
  className,
}: {
  value: string | null;
  className: string;
}) {
  if (value === null) return <span className={className}>∅</span>;
  const clipped =
    value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS)}…` : value;
  return (
    <span className={className} title={clipped === value ? undefined : value}>
      {clipped}
    </span>
  );
}
