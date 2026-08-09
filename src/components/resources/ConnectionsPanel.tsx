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

import { Section } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import {
  connectionGroups,
  describeExistence,
  type ConnRow,
} from "@/lib/connections";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import { ResourceRef } from "./ResourceRef";
import { ResourceName, RESOURCE_NAME_SHELL } from "./ResourceName";
import type { ObjectRef, ResourceConnections } from "@/generated/types";

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

function Row({ row }: { row: ConnRow }) {
  const existence = row.object
    ? describeExistence(row.object, row.verifiable ?? false)
    : null;
  // One way stays on the name's line, as a name and what it is for. Several
  // become their own lines, because five clauses joined by commas is a
  // sentence nobody finishes.
  const inline = row.ways.length === 1 ? row.ways[0] : null;
  return (
    <div className="grid grid-cols-[minmax(0,148px)_minmax(0,1fr)] items-baseline gap-3 py-[3px]">
      <span className="min-w-0 break-words text-[11px] text-fg-fnt">
        {row.label}
      </span>
      <div className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {row.object && <Name object={row.object} />}
          {(inline || row.detail) && (
            <span
              className={cn(
                "min-w-0 text-[11px]",
                row.object ? "text-fg-fnt" : "text-fg-mut"
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
  const where = subject.namespace
    ? `in ${subject.namespace}`
    : "in the cluster";
  return (
    <Section>
      <p className="text-xs text-fg-mut">
        Nothing {where} states an edge to this {subject.kind}.
      </p>
      <p className="text-[11px] text-fg-fnt">
        Every pod, Deployment, StatefulSet, DaemonSet, Job, CronJob and Ingress{" "}
        {where} was read; none of them names it.
      </p>
    </Section>
  );
}

export function ConnectionsPanel({ query }: { query: ConnectionsQuery }) {
  const { data, isPending, error } = query;

  if (isPending) {
    return (
      <Section>
        <p className="text-xs text-fg-fnt">Reading what connects to this…</p>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section>
        <p className="text-xs text-err">
          Could not read what connects to this.
        </p>
        <p className="text-[11px] text-fg-fnt">
          {error?.message ?? "The cluster did not answer."}
        </p>
      </Section>
    );
  }

  const groups = connectionGroups(data);
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
