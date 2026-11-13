/**
 * Everything else this object touches, grouped by the question rather than
 * by the kind.
 *
 * "Related resources: ConfigMap, Secret, PVC, Node, ServiceAccount" is a
 * pile. *What does this need to run* is a question, and the backend returns
 * typed edges rather than groups precisely so the answering happens once,
 * here, instead of on ten detail pages.
 */

import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Ban, ExternalLink, Unlink } from "lucide-react";

import { PerfProfiler } from "@/lib/perf-profiler";

import { Section } from "@/components/ui/section";
import { Eyebrow, Reading } from "@/components/ui/states";
import { Unknown } from "@/components/ui/unknown";
import { PATH_PATIENCE_MS, useOverdue } from "./useOverdue";
import { shortRevision } from "@/integrations";
import { cn } from "@/lib/utils";
import {
  connectionGroups,
  rowExistence,
  type ConnRow,
  type OutsideEnd,
} from "@/lib/connections";
import type { ConnectionsRead } from "@/hooks/useConnections";
import { useDelivery } from "../-delivery/useDelivery";
import { openExternal } from "@/lib/open-external";
import type { DeliveryQuery } from "@/integrations";
import { ResourceRef } from "@/components/object/ResourceRef";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { crdInGroup } from "@/lib/links";
import {
  ResourceName,
  RESOURCE_NAME_SHELL,
} from "@/components/object/ResourceName";
import type { ObjectRef, ResourceConnections } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { NodeRef } from "./NodeRef";
import { ResourceType } from "@/lib/resource-registry";

function Name({ object }: { object: ObjectRef }) {
  const { crdFor } = useCrdIndex();
  const crd =
    object.group === undefined
      ? undefined
      : crdInGroup({ kind: object.kind, group: object.group }, crdFor);
  if (object.existence === "missing") {
    return (
      <span className={RESOURCE_NAME_SHELL}>
        <ResourceName
          kind={object.kind}
          name={object.name}
          crd={crd}
          showKind={false}
        />
      </span>
    );
  }
  if (object.kind === ResourceType.Node) return <NodeRef name={object.name} />;
  return (
    <ResourceRef
      kind={object.kind}
      name={object.name}
      namespace={object.namespace}
      crd={crd}
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
  const t = useT();
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <Link
        {...end.to}
        className="font-mono text-xs text-fg-mid hover:underline"
      >
        {end.name}
      </Link>
      {end.revision &&
        (end.link ? (
          <button
            type="button"
            onClick={() => openExternal(end.link!.url, end.link!.site, t)}
            className="inline-flex items-baseline gap-0.5 font-mono text-caption text-info hover:underline"
          >
            {shortRevision(end.revision)}
            <ExternalLink
              className="h-2.5 w-2.5 self-center"
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="font-mono text-caption text-fg-fnt">
            {shortRevision(end.revision)}
          </span>
        ))}
    </span>
  );
}

const MANY_MISSING = 4;
const MANY_KEYS = 6;

const keysFolded = (row: ConnRow) => (row.keysReferenced ?? 0) > MANY_KEYS;

function missingLines(row: ConnRow, t: ReturnType<typeof useT>) {
  return (row.missingKeys ?? []).map((key) => (
    <p
      key={key.key}
      className={cn(
        "flex items-center gap-1 text-caption",
        key.optional ? "text-fg-fnt" : "text-err"
      )}
    >
      <Unlink className="h-3 w-3 flex-none" aria-hidden="true" />
      {t("nav", key.optional ? "keyNotInSubjectOptional" : "keyNotInSubject", {
        key: key.key,
        kind: key.from,
      })}
    </p>
  ));
}

function MissingKeys({ row }: { row: ConnRow }) {
  const t = useT();
  const missing = row.missingKeys ?? [];
  const lines = missingLines(row, t);
  if (missing.length < MANY_MISSING || !missing.every((key) => key.optional))
    return <>{lines}</>;
  return (
    <details className="group text-caption text-fg-fnt">
      <summary className="cursor-pointer select-none rounded py-0.5 hover:text-fg-mut">
        {t("nav", "keysSummaryOptional", {
          n: row.keysReferenced ?? missing.length,
          absent: missing.length,
        })}
      </summary>
      {lines}
    </details>
  );
}

/** A reference to many keys is one line with a disclosure; absent keys that are required stay outside it. */
function KeysFolded({ row }: { row: ConnRow }) {
  const t = useT();
  const missing = row.missingKeys ?? [];
  const required = missing.filter((key) => !key.optional);
  return (
    <>
      <details className="group text-caption text-fg-fnt">
        <summary className="cursor-pointer select-none rounded py-0.5 hover:text-fg-mut">
          {t("count", "keysReferenced", { n: row.keysReferenced ?? 0 })}
          {missing.length > 0 &&
            `, ${t("count", "keysReferencedAbsent", { absent: missing.length })}`}
        </summary>
        {row.ways.map((way) => (
          <p key={way} className="text-caption text-fg-fnt">
            {way}
          </p>
        ))}
        {missingLines(
          { ...row, missingKeys: missing.filter((key) => key.optional) },
          t
        )}
      </details>
      {missingLines({ ...row, missingKeys: required }, t)}
    </>
  );
}

function Row({ row }: { row: ConnRow }) {
  const t = useT();
  const { existence, missing } = rowExistence(row, t);
  // One way stays on the name's line, as a name and what it is for. Several
  // become their own lines, because five clauses joined by commas is a
  // sentence nobody finishes.
  const inline = row.ways.length === 1 ? row.ways[0] : null;
  return (
    <div className="grid grid-cols-[minmax(0,148px)_minmax(0,1fr)] items-baseline gap-3 py-[3px]">
      <span className="min-w-0 wrap-break-word text-caption text-fg-fnt">
        {row.label}
      </span>
      <div className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {row.object && <Name object={row.object} />}
          {row.outside && <Outside end={row.outside} />}
          {(inline || row.detail) && (
            <span
              className={cn(
                "min-w-0 text-caption",
                row.object || row.outside ? "text-fg-fnt" : "text-fg-mut"
              )}
            >
              {[inline, row.detail].filter(Boolean).join(" · ")}
            </span>
          )}
          {existence && (
            <span
              className={cn(
                "text-caption",
                missing ? "text-err" : "text-fg-fnt"
              )}
            >
              {existence}
            </span>
          )}
        </span>
        {row.refused && (
          <p className="flex items-center gap-1 text-caption text-err">
            <Ban className="h-3 w-3 flex-none" aria-hidden="true" />
            {row.refused}
          </p>
        )}
        {keysFolded(row) && !inline ? (
          <KeysFolded row={row} />
        ) : (
          <>
            {!inline &&
              row.ways.map((way) => (
                <p key={way} className="text-caption text-fg-fnt">
                  {way}
                </p>
              ))}
            <MissingKeys row={row} />
          </>
        )}
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
      <p className="text-caption text-fg-fnt">
        {t("empty", "everyWorkloadRead", { where })}
      </p>
    </Section>
  );
}

export function ConnectionsPanel(
  props: React.ComponentProps<typeof ConnectionsPanelInner>
) {
  return (
    <PerfProfiler id="connections">
      <ConnectionsPanelInner {...props} />
    </PerfProfiler>
  );
}

function ConnectionsPanelInner({
  query,
  delivery,
}: {
  query: ConnectionsRead;
  delivery?: DeliveryQuery | null;
}) {
  const t = useT();
  const { data, isPending, error } = query;
  const { deliveries } = useDelivery(delivery ?? null);
  const overdue = useOverdue(isPending, PATH_PATIENCE_MS);

  if (overdue) {
    return (
      <Section>
        <Unknown
          question={t("empty", "couldNotReadWhatConnects")}
          error={t("empty", "noAnswerWithin", {
            n: PATH_PATIENCE_MS / 1000,
          })}
          onRetry={() => void query.refetch()}
        />
      </Section>
    );
  }
  if (isPending) {
    return (
      <Section>
        <Reading>{t("empty", "readingWhatConnects")}</Reading>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section>
        <Unknown
          question={t("empty", "couldNotReadWhatConnects")}
          error={error ?? t("empty", "clusterDidNotAnswer")}
          onRetry={() => void query.refetch()}
        />
      </Section>
    );
  }

  const groups = connectionGroups(data, t, deliveries);
  if (groups.length === 0) return <Nothing subject={data.subject} />;

  return (
    <Section className="gap-[18px]">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col">
          <Eyebrow className="pb-1.5">
            {group.title}
            {group.caption && (
              <span className="ml-2 font-normal normal-case tracking-normal text-caption text-fg-fnt">
                {group.caption}
              </span>
            )}
          </Eyebrow>
          {group.rows.map((row) => (
            <Row key={`${group.key}/${row.key}`} row={row} />
          ))}
        </div>
      ))}
    </Section>
  );
}
