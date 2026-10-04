import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { Dependent, NotRead } from "@/generated/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RouteLink } from "@/components/ui/route-link";
import { TextSkeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { objectLink } from "@/lib/links";
import { isResourceType } from "@/lib/resource-registry";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { cn } from "@/lib/utils";
import { readingOf, useDependents } from "./ownership";

const linkOf = (dependent: Dependent) =>
  objectLink({
    kind: dependent.kind,
    name: dependent.name,
    namespace: dependent.namespace,
    crd: isResourceType(dependent.kind)
      ? undefined
      : dependent.group
        ? `${dependent.plural}.${dependent.group}`
        : dependent.plural,
  });

/**
 * What this object owns, as a tree that opens a level at a time. Read only
 * while the tab is on screen: asking is what starts the cluster-wide index,
 * and a page nobody opened this tab on must not start it.
 */
export function OwnsPanel({ uid }: { uid: string }) {
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
  return (
    <div className="flex flex-col gap-3">
      {dependents.length === 0 ? (
        <p className="text-sm text-fg-mut">{t("owns", "none")}</p>
      ) : (
        <ul role="tree" className="flex flex-col">
          {dependents.map((dependent) => (
            <DependentRow key={dependent.uid} dependent={dependent} depth={0} />
          ))}
        </ul>
      )}
      <NotReadLine notRead={notRead} />
    </div>
  );
}

function DependentRow({
  dependent,
  depth,
}: {
  dependent: Dependent;
  depth: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const link = linkOf(dependent);
  const opens = dependent.dependents > 0;

  return (
    <li role="treeitem" aria-expanded={opens ? open : undefined}>
      <div
        className="flex min-h-8 items-center gap-2 text-sm"
        style={{ paddingLeft: `${depth * 20}px` }}
      >
        {opens ? (
          <button
            type="button"
            onClick={() => setOpen((was) => !was)}
            aria-label={t("owns", open ? "collapse" : "expand", {
              name: dependent.name,
            })}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-mut hover:bg-hover"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                open && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span className="w-6" aria-hidden />
        )}
        <span className="text-fg-fnt">{dependent.kind}</span>
        {link ? (
          <RouteLink {...link} className="font-mono text-info hover:underline">
            {dependent.name}
          </RouteLink>
        ) : (
          <span className="font-mono">{dependent.name}</span>
        )}
        {dependent.namespace && (
          <span className="font-mono text-xs text-fg-fnt">
            {dependent.namespace}
          </span>
        )}
        {opens && (
          <span className="text-xs tabular-nums text-fg-mut">
            {t("count", "dependents", { n: dependent.dependents })}
          </span>
        )}
        {!dependent.controlled && (
          <span className="text-xs text-fg-fnt">
            {t("owns", "notController")}
          </span>
        )}
      </div>
      {open && <Children uid={dependent.uid} depth={depth + 1} />}
    </li>
  );
}

function Children({ uid, depth }: { uid: string; depth: number }) {
  const owned = useDependents(uid, true);
  if (!owned.data)
    return (
      <div style={{ paddingLeft: `${depth * 20 + 32}px` }}>
        <TextSkeleton lines={1} />
      </div>
    );
  return (
    <ul role="group" className="flex flex-col">
      {owned.data.dependents.map((dependent) => (
        <DependentRow key={dependent.uid} dependent={dependent} depth={depth} />
      ))}
    </ul>
  );
}

/** Every kind the index could not vouch for, folded behind a count. */
export function NotReadLine({ notRead }: { notRead: NotRead }) {
  const t = useT();
  if (notRead.kinds.length === 0 && notRead.groups.length === 0) return null;
  return (
    <details className="text-xs text-fg-mut">
      <summary className="cursor-pointer select-none">
        {t("count", "kindsNotRead", { n: notRead.kinds.length })}
      </summary>
      <p className="mt-1 leading-relaxed">
        {notRead.kinds.map((reading) => readingOf(reading, t)).join(", ")}
      </p>
      {notRead.groups.length > 0 && (
        <p className="mt-1">
          {t("owns", "groupsUnread", {
            groups: notRead.groups.map((group) => group.group).join(", "),
          })}
        </p>
      )}
    </details>
  );
}
