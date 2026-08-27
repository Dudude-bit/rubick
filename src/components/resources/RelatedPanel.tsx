/**
 * A custom resource's Connections, which is a different thing from a core
 * object's and says so.
 *
 * `ConnectionsPanel` draws a neighbourhood the backend computed: selectors,
 * volumes, endpoints, owner chains — joins that are the same on every cluster
 * and that this app knows how to make. None of them exist for a kind it has
 * never heard of, so nothing here is computed. Every row is either an owner
 * reference, which upstream Kubernetes guarantees, or something the object's
 * own controller wrote down and an integration read back.
 *
 * The consequence is a shape that panel does not need: **the tab has to be
 * able to say it does not know.** An empty Connections tab on a Pod means the
 * pod touches nothing. An empty one on a `SealedSecret` means nobody wrote an
 * integration for SealedSecrets, and drawing the two the same way would turn
 * a gap in this app into a claim about somebody's cluster.
 */

import { useT } from "@/i18n/useT";
import { Section } from "@/components/ui/section";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { RelatedObjects, RelatedRef } from "@/hooks/useRelatedObjects";
import { ResourceRef } from "./ResourceRef";

const GROUP_HEADING =
  "text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt";

/** Rows in the order they were produced, grouped by what the relation is. */
function byRelation(
  related: RelatedRef[]
): Array<[RelatedRef["relation"], RelatedRef[]]> {
  const groups = new Map<RelatedRef["relation"], RelatedRef[]>();
  for (const entry of related) {
    const existing = groups.get(entry.relation);
    if (existing) existing.push(entry);
    else groups.set(entry.relation, [entry]);
  }
  return [...groups];
}

function Row({ entry }: { entry: RelatedRef }) {
  return (
    <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] items-baseline gap-x-3 border-b border-hair py-1 last:border-b-0">
      <span className="min-w-0 truncate">
        <ResourceRef
          kind={entry.kind}
          name={entry.name}
          namespace={entry.namespace}
          crd={entry.crd}
          showKind={false}
        />
      </span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="flex-none text-[11px] text-fg-fnt">
          {entry.namespace ?? "cluster-wide"}
        </span>
        {entry.note && (
          <span
            className={cn(
              "min-w-0 wrap-break-word font-mono text-[11px]",
              entry.tone === "err"
                ? "text-err"
                : entry.tone === "warn"
                  ? "text-warn"
                  : "text-fg-mut"
            )}
          >
            {entry.note}
          </span>
        )}
      </span>
    </div>
  );
}

export function RelatedPanel({
  query,
  kind,
}: {
  query: RelatedObjects;
  /** Named in the sentence, so "nothing reads a SealedSecret" is specific. */
  kind: string;
}) {
  const t = useT();
  if (query.isPending && query.related.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-3.5 py-3" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-3" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {query.error && (
        <p className="max-w-[64ch] text-[11.5px] text-warn">
          An integration that reads {kind} objects could not answer, so what is
          below is short by an unknown amount.{" "}
          <span className="font-mono text-fg-mut">{query.error.message}</span>
        </p>
      )}

      {byRelation(query.related).map(([relation, rows]) => (
        <Section key={relation}>
          <span className={GROUP_HEADING}>{t("readings", relation)}</span>
          <div className="mt-1 flex flex-col">
            {rows.map((entry) => (
              <Row
                key={`${entry.relation}/${entry.kind}/${entry.namespace}/${entry.name}`}
                entry={entry}
              />
            ))}
          </div>
        </Section>
      ))}

      {/*
        The two sentences this panel exists to keep apart. Neither is an empty
        state in the usual sense — one is a fact about the object and the other
        is an admission about the app, and a reader who cannot tell them apart
        will believe whichever is worse.
      */}
      {query.related.length === 0 &&
        (query.claimed ? (
          <p className="max-w-[64ch] text-[11.5px] text-fg-mut">
            Nothing points at anything: this {kind} names no other object right
            now, and nothing in the cluster owns it.
          </p>
        ) : (
          <p className="max-w-[64ch] text-[11.5px] text-fg-mut">
            No integration in this app reads {kind} objects, so nothing here
            knows what this one is connected to. That is a gap in the app and
            not a fact about the cluster — the object&rsquo;s own spec and
            status, on the tabs beside this one, are what it says about itself.
          </p>
        ))}

      {query.related.length > 0 && !query.claimed && (
        <p className="max-w-[64ch] text-[11.5px] text-fg-fnt">
          Only the owner reference, which every object carries. No integration
          in this app reads {kind} objects, so anything else this one points at
          is not shown here.
        </p>
      )}
    </div>
  );
}
