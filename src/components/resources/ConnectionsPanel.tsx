/**
 * Everything else this object touches, grouped by the question rather than
 * by the kind.
 *
 * "Related resources: ConfigMap, Secret, PVC, Node, ServiceAccount" is a
 * pile. *What does this need to run* is a question, and the backend returns
 * typed edges rather than groups precisely so the answering happens once,
 * here, instead of on ten detail pages.
 *
 * The traffic edges are not repeated: the chain on the Overview draws them.
 */

import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { Section } from "@/components/ui/section";
import { shortRevision } from "@/integrations";
import { cn } from "@/lib/utils";
import {
  connectionGroups,
  describeExistence,
  type ConnRow,
  type OutsideEnd,
} from "@/lib/connections";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import { useDelivery } from "@/hooks/useDelivery";
import { openExternal } from "@/lib/open-external";
import type { DeliveryQuery } from "@/integrations";
import { ResourceRef } from "./ResourceRef";
import { ResourceName, RESOURCE_NAME_SHELL } from "./ResourceName";
import type { ObjectRef, ResourceConnections } from "@/generated/types";
import { useT } from "@/i18n/useT";

const GROUP_HEADING =
  "text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt";

function Name({ object }: { object: ObjectRef }) {
  if (object.existence === "missing") {
    return (
      <span className={RESOURCE_NAME_SHELL}>
        <ResourceName kind={object.kind} name={object.name} showKind={false} />
      </span>
    );
  }
  return (
    <ResourceRef
      kind={object.kind}
      name={object.name}
      namespace={object.namespace}
      showKind={false}
    />
  );
}

/**
 * The far end of the one edge that leaves the cluster.
 *
 * Two halves, and the split is the point: the controller's object is in this
 * app and is a route, the commit is not and is a link out. Drawing them as one
 * thing would either send the reader to the browser for something the app has,
 * or promise a page for a revision this app cannot show.
 */
function Outside({ end }: { end: OutsideEnd }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <Link
        to={end.to}
        className="font-mono text-xs text-fg-mid hover:underline"
      >
        {end.name}
      </Link>
      {end.revision &&
        (end.link ? (
          <button
            type="button"
            onClick={() => openExternal(end.link!.url, end.link!.site)}
            className="inline-flex items-baseline gap-0.5 font-mono text-[11px] text-info hover:underline"
          >
            {shortRevision(end.revision)}
            <ExternalLink
              className="h-2.5 w-2.5 self-center"
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="font-mono text-[11px] text-fg-fnt">
            {shortRevision(end.revision)}
          </span>
        ))}
    </span>
  );
}

function Row({ row }: { row: ConnRow }) {
  const t = useT();
  const existence = row.object
    ? describeExistence(row.object, t, row.verifiable ?? false)
    : null;
  // One way stays on the name's line, as a name and what it is for. Several
  // become their own lines, because five clauses joined by commas is a
  // sentence nobody finishes.
  const inline = row.ways.length === 1 ? row.ways[0] : null;
  return (
    <div className="grid grid-cols-[minmax(0,148px)_minmax(0,1fr)] items-baseline gap-3 py-[3px]">
      <span className="min-w-0 wrap-break-word text-[11px] text-fg-fnt">
        {row.label}
      </span>
      <div className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {row.object && <Name object={row.object} />}
          {row.outside && <Outside end={row.outside} />}
          {(inline || row.detail) && (
            <span
              className={cn(
                "min-w-0 text-[11px]",
                row.object || row.outside ? "text-fg-fnt" : "text-fg-mut"
              )}
            >
              {[inline, row.detail].filter(Boolean).join(" · ")}
            </span>
          )}
          {existence && (
            <span
              className={cn(
                "text-[11px]",
                row.object?.existence === "missing" ? "text-err" : "text-fg-fnt"
              )}
            >
              {existence}
            </span>
          )}
        </span>
        {!inline &&
          row.ways.map((way) => (
            <p key={way} className="text-[11px] text-fg-fnt">
              {way}
            </p>
          ))}
      </div>
    </div>
  );
}

/**
 * The screen for "the cluster answered and there is genuinely nothing".
 *
 * It states what was read as well as what was found, because an empty page
 * that only says "nothing" is indistinguishable from a page that never
 * asked — which is the mistake this whole view exists to stop making.
 */
function Nothing({ subject }: { subject: ResourceConnections["subject"] }) {
  const t = useT();
  const where = subject.namespace
    ? t("empty", "inNamespaceWhere", { namespace: subject.namespace })
    : t("empty", "inClusterWhere");
  return (
    <Section>
      <p className="text-xs text-fg-mut">
        {t("empty", "nothingStatesEdge", { where, kind: subject.kind })}
      </p>
      <p className="text-[11px] text-fg-fnt">
        {t("empty", "everyWorkloadRead", { where })}
      </p>
    </Section>
  );
}

export function ConnectionsPanel({
  query,
  delivery,
}: {
  query: ConnectionsQuery;
  delivery?: DeliveryQuery | null;
}) {
  const t = useT();
  const { data, isPending, error } = query;
  const { deliveries } = useDelivery(delivery ?? null);

  if (isPending) {
    return (
      <Section>
        <p className="text-xs text-fg-fnt">
          {t("empty", "readingWhatConnects")}
        </p>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section>
        <p className="text-xs text-err">
          {t("empty", "couldNotReadWhatConnects")}
        </p>
        <p className="text-[11px] text-fg-fnt">
          {error?.message ?? t("empty", "clusterDidNotAnswer")}
        </p>
      </Section>
    );
  }

  const groups = connectionGroups(data, t, deliveries);
  if (groups.length === 0) return <Nothing subject={data.subject} />;

  return (
    <Section className="gap-[18px]">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col">
          <p className={cn(GROUP_HEADING, "pb-1.5")}>
            {group.title}
            {group.caption && (
              <span className="ml-2 font-normal normal-case tracking-normal text-[11px] text-fg-fnt">
                {group.caption}
              </span>
            )}
          </p>
          {group.rows.map((row) => (
            <Row key={`${group.key}/${row.key}`} row={row} />
          ))}
        </div>
      ))}
    </Section>
  );
}
