import { ChevronRight, EyeOff, Inbox, Link2Off, Loader2 } from "lucide-react";
import { useState } from "react";

import type { Dependent, NotRead } from "@/generated/types";
import { ResourceRef } from "@/components/object/ResourceRef";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextSkeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { cn } from "@/lib/utils";
import { crdOf, useDependents } from "./ownership";
import { ReadingChips } from "./ReadingChips";

/**
 * What this object owns, as a tree that opens a level at a time. Read only
 * while the tab is on screen: asking is what starts the cluster-wide index,
 * and a page nobody opened this tab on must not start it.
 */
export function OwnsPanel({
  uid,
  namespace,
}: {
  uid: string;
  namespace?: string | null;
}) {
  const t = useT();
  const visible = useSurfaceVisible();
  const owned = useDependents(uid, visible);

  if (owned.isError && !owned.data)
    return (
      <Alert variant="destructive">
        {t("owns", "failed", { error: errorToShow(owned.error) })}{" "}
        <Button variant="link" size="sm" onClick={() => void owned.refetch()}>
          {t("owns", "retry")}
        </Button>
      </Alert>
    );
  if (!owned.data) return <TextSkeleton lines={3} />;

  const { dependents, notRead } = owned.data;
  const listing = notRead.kinds.filter(
    (reading) => reading.reading.says === "syncing"
  ).length;
  return (
    <div className="flex flex-col gap-4">
      {dependents.length > 0 ? (
        <ul role="tree" className="flex flex-col">
          {dependents.map((dependent) => (
            <DependentRow
              key={dependent.uid}
              dependent={dependent}
              parentNamespace={namespace ?? null}
            />
          ))}
        </ul>
      ) : listing > 0 ? (
        <p className="flex items-center gap-2 text-sm text-info">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t("count", "kindsReading", { n: listing })}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-fg-mut">
          <Inbox className="h-4 w-4 text-fg-fnt" aria-hidden="true" />
          {t("owns", "none")}
        </p>
      )}
      <NotReadSummary notRead={notRead} />
    </div>
  );
}

function DependentRow({
  dependent,
  parentNamespace,
}: {
  dependent: Dependent;
  parentNamespace: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const opens = dependent.dependents > 0;

  return (
    <li role="treeitem" aria-expanded={opens ? open : undefined}>
      <div className="flex min-h-8 items-center gap-2 rounded-md pr-2 hover:bg-hover">
        {opens ? (
          <button
            type="button"
            onClick={() => setOpen((was) => !was)}
            aria-label={t("owns", open ? "collapse" : "expand", {
              name: dependent.name,
            })}
            className="flex h-6 w-6 flex-none items-center justify-center rounded text-fg-mut hover:bg-hover hover:text-fg"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none",
                open && "rotate-90"
              )}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="w-6 flex-none" aria-hidden="true" />
        )}
        <ResourceRef
          kind={dependent.kind}
          name={dependent.name}
          namespace={dependent.namespace}
          crd={crdOf(dependent)}
          showNamespace={
            !!dependent.namespace && dependent.namespace !== parentNamespace
          }
        />
        {opens && (
          <span className="rounded-full bg-hover px-2 py-px text-[11px] tabular-nums text-fg-mut">
            {t("count", "dependents", { n: dependent.dependents })}
          </span>
        )}
        {!dependent.controlled && (
          <span className="inline-flex items-center gap-1 text-[11px] text-fg-fnt">
            <Link2Off className="h-3 w-3" aria-hidden="true" />
            {t("owns", "notController")}
          </span>
        )}
      </div>
      {open && <Children uid={dependent.uid} namespace={dependent.namespace} />}
    </li>
  );
}

function Children({
  uid,
  namespace,
}: {
  uid: string;
  namespace: string | null;
}) {
  const owned = useDependents(uid, true);
  return (
    <ul
      role="group"
      className="ml-3 flex flex-col border-l border-hair pl-2 duration-200 animate-in fade-in motion-reduce:animate-none"
    >
      {owned.data ? (
        owned.data.dependents.map((dependent) => (
          <DependentRow
            key={dependent.uid}
            dependent={dependent}
            parentNamespace={namespace}
          />
        ))
      ) : (
        <li className="py-1 pl-8">
          <TextSkeleton lines={1} />
        </li>
      )}
    </ul>
  );
}

/** Every kind the index could not vouch for, folded behind a count. */
function NotReadSummary({ notRead }: { notRead: NotRead }) {
  const t = useT();
  if (notRead.kinds.length === 0 && notRead.groups.length === 0) return null;
  return (
    <details className="group text-xs">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1 py-0.5 text-fg-mut hover:bg-hover hover:text-fg">
        <ChevronRight
          className="h-3 w-3 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
        {t("count", "kindsNotRead", {
          n: notRead.kinds.length + notRead.groups.length,
        })}
      </summary>
      <div className="mt-2 pl-1">
        <ReadingChips kinds={notRead.kinds} groups={notRead.groups} />
      </div>
    </details>
  );
}
