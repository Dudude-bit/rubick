import { Fragment } from "react";

import type { Ancestor, LineageStop } from "@/generated/types";
import { RouteLink } from "@/components/ui/route-link";
import { useT, type T } from "@/i18n/useT";
import { objectLink } from "@/lib/links";
import { isResourceType } from "@/lib/resource-registry";
import { useLineage } from "./ownership";
import type { ServedResource } from "./served";

const linkOf = (ancestor: Ancestor) =>
  objectLink({
    kind: ancestor.kind,
    name: ancestor.name,
    namespace: ancestor.namespace,
    crd: isResourceType(ancestor.kind)
      ? undefined
      : ancestor.group
        ? `${ancestor.plural}.${ancestor.group}`
        : ancestor.plural,
  });

function stopWords(stop: LineageStop, t: T): string {
  switch (stop.says) {
    case "ownerGone":
      return t("lineage", "ownerGone", { kind: stop.kind, name: stop.name });
    case "ownerUnread":
      return t("lineage", "ownerUnread", { kind: stop.kind, name: stop.name });
    case "kindNotServed":
      return t("lineage", "kindNotServed", { kind: stop.kind });
    case "several":
      return t("lineage", "several");
    case "tooDeep":
      return t("lineage", "tooDeep");
  }
}

/**
 * The controllers above this object, top first, each a link to its page,
 * on its own line over the title.
 * Where the chain stops short of the top it says why at the left end: an
 * owner that is gone and one that could not be read are different words.
 * Nothing is drawn for an object nothing owns.
 */
export function LineageTrail({
  served,
  name,
  namespace,
}: {
  served: ServedResource | null;
  name: string;
  namespace?: string | null;
}) {
  const t = useT();
  const lineage = useLineage(served, name, namespace);
  const data = lineage.data;
  if (!data || (data.ancestors.length === 0 && !data.stop)) return null;
  const top = [...data.ancestors].reverse();
  const unread =
    data.stop?.says === "ownerUnread" ? data.stop.message : undefined;

  return (
    <nav
      aria-label={t("lineage", "label")}
      className="flex basis-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-fg-mut"
    >
      {data.stop && (
        <span className="text-fg-fnt" title={unread}>
          {stopWords(data.stop, t)}
        </span>
      )}
      {top.map((ancestor, index) => {
        const link = linkOf(ancestor);
        return (
          <Fragment key={ancestor.uid}>
            {(index > 0 || data.stop) && (
              <span aria-hidden className="text-fg-fnt">
                ›
              </span>
            )}
            <span className="text-fg-fnt">{ancestor.kind}</span>
            {link ? (
              <RouteLink
                {...link}
                className="font-mono text-info hover:underline"
              >
                {ancestor.name}
              </RouteLink>
            ) : (
              <span className="font-mono">{ancestor.name}</span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
