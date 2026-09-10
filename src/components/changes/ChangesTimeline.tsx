import { ResourceRef } from "@/components/resources/ResourceRef";
import type { ChangeItem, FieldChange, JournalEntry } from "@/lib/changes";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

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
}: {
  items: ChangeItem[];
  /** A moment the reader came from; everything after it is marked. */
  since?: number | null;
  /** Name the object on each row, for a page that mixes many. */
  showObject?: boolean;
}) {
  const t = useT();
  if (items.length === 0) {
    return (
      <p className="px-1.5 py-1 text-xs text-fg-fnt">
        {t("changes", "nothingInWindow")}
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-1 text-xs">
      {items.map((item, index) => {
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
            <Row item={item} showObject={showObject} />
          </li>
        );
      })}
    </ol>
  );
}

function Row({ item, showObject }: { item: ChangeItem; showObject: boolean }) {
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
    case "revision": {
      const { revision, changes } = item;
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
          </div>
          {revision.changeCause ? (
            <p className="text-fg-mut">
              <span className="font-mono text-[11px] text-fg-fnt">
                {t("changes", "changeCause")}
              </span>{" "}
              {revision.changeCause}
            </p>
          ) : null}
          {changes === null ? (
            <p className="text-[11px] text-fg-fnt">
              {t("changes", "revisionOldest")}
            </p>
          ) : changes.length === 0 ? (
            <p className="text-[11px] text-fg-fnt">
              {t("changes", "unchangedTemplate")}
            </p>
          ) : (
            <ul className="mt-0.5 flex flex-col gap-px">
              {changes.map((change, index) => (
                <li key={index} className="font-mono text-[11px]">
                  <Field change={change} />
                </li>
              ))}
            </ul>
          )}
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
        </div>
      );
    }
  }
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
      <span className="text-fg-mut">{change.from ?? "∅"}</span>
      <span className="text-fg-fnt"> → </span>
      <span className="text-fg">{change.to ?? "∅"}</span>
    </>
  );
}

/**
 * One journal entry in words.
 *
 * Exported because the pinned-service cards say the same sentence about the
 * same entry, and a second switch over `field` is how the two surfaces come
 * to disagree the next time a field is added.
 */
export function Journal({ item }: { item: JournalEntry }) {
  const t = useT();
  const from = item.from ?? "∅";
  const to = item.to ?? "∅";
  switch (item.field) {
    case "created":
      return <>{t("changes", "journalCreated", { kind: item.kind })}</>;
    case "deleted":
      return <>{t("changes", "journalDeleted", { kind: item.kind })}</>;
    case "generation":
      return <>{t("changes", "journalGeneration", { from, to })}</>;
    case "image":
      return <>{t("changes", "journalImage", { from, to })}</>;
    case "replicas":
      return <>{t("changes", "journalReplicas", { from, to })}</>;
    case "annotation":
      return (
        <>
          {t("changes", "journalAnnotation", { key: item.key ?? "", from, to })}
        </>
      );
  }
}
