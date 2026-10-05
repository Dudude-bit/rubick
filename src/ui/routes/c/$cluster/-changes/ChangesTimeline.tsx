import { useState } from "react";
import { ChevronDown, ChevronRight, CirclePlus, Undo2 } from "lucide-react";

import { ResourceRef } from "@/components/object/ResourceRef";
import {
  canRollBackTo,
  journalWords,
  type ChangeItem,
  type Comparison,
  type FieldChange,
  type JournalEntry,
  type Revision,
} from "@/lib/changes";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

/** A busy cluster's week runs to thousands of rows; the tail is said in words. */
const MAX_ROWS = 300;

const clock = (ms: number) =>
  new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function ChangesTimeline({
  items,
  since,
  showObject = false,
  onRollback,
}: {
  items: ChangeItem[];
  /** A moment the reader came from; everything after it is marked. */
  since?: number | null;
  /** Name the object on each row, for a page that mixes many. */
  showObject?: boolean;
  /** Offered on every older revision whose template was read. */
  onRollback?: (revision: Revision) => void;
}) {
  const t = useT();
  if (items.length === 0) {
    return (
      <p className="px-1.5 py-1 text-xs text-fg-fnt">
        {t("changes", "nothingInWindow")}
      </p>
    );
  }
  const drawn = items.slice(0, MAX_ROWS);
  return (
    <ol className="flex flex-col gap-1 text-xs">
      {drawn.map((item, index) => {
        const after = since != null && item.at !== null && item.at >= since;
        return (
          <li
            key={index}
            className={cn(
              "grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-2 rounded px-1.5 py-1",
              after && "bg-sel/40"
            )}
            data-after-since={after ? "true" : undefined}
          >
            <span className="font-mono text-[11px] text-fg-fnt">
              {item.kind === "gap"
                ? ""
                : item.at === null
                  ? "?"
                  : clock(item.at)}
            </span>
            <Row item={item} showObject={showObject} onRollback={onRollback} />
          </li>
        );
      })}
      {items.length > drawn.length ? (
        <li className="px-1.5 py-1 text-[11px] text-fg-fnt">
          {t("changes", "moreRows", { n: items.length - drawn.length })}
        </li>
      ) : null}
    </ol>
  );
}

function Row({
  item,
  showObject,
  onRollback,
}: {
  item: ChangeItem;
  showObject: boolean;
  onRollback?: (revision: Revision) => void;
}) {
  const t = useT();
  switch (item.kind) {
    case "gap":
      return (
        <div
          role="note"
          className="rounded border border-dashed border-warn/60 bg-warn/5 px-2 py-1 text-[11px] text-warn"
        >
          {t("changes", "notObserved", {
            from: clock(item.gap.from),
            to: clock(item.gap.to),
          })}
        </div>
      );
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
              <button
                type="button"
                onClick={() => onRollback(revision)}
                className="ml-auto inline-flex items-center gap-1 rounded text-[11px] text-info hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info"
              >
                <Undo2 className="h-3 w-3" aria-hidden="true" />
                {t("action", "rollBackToThis")}
              </button>
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
    case "helm":
      return (
        <div className="min-w-0">
          <span className="text-fg">
            {t("changes", "helmRevision", {
              n: item.revision.revision,
              chart: item.revision.chart,
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
    case "journal": {
      const { entry } = item;
      return (
        <div className="min-w-0">
          {showObject ? (
            <ResourceRef
              kind={entry.kind}
              name={entry.name}
              namespace={entry.namespace}
              showNamespace
            />
          ) : null}
          <span className={cn("font-mono text-[11px]", showObject && "ml-2")}>
            <Journal item={entry} />
          </span>
          {entry.atRelist ? (
            <p className="text-[11px] text-warn">
              {t("changes", "journalSeenAtRelist")}
            </p>
          ) : null}
        </div>
      );
    }
  }
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

/** One journal entry in words, as {@link journalWords} states it. */
export function Journal({ item }: { item: JournalEntry }) {
  const t = useT();
  return <>{journalWords(item, t)}</>;
}
