/**
 * What a Service publishes, and what it does not.
 *
 * Two lists, and the second is the point. "Published" is what the cluster
 * does; "matches the selector, not published" is the gap between what
 * somebody meant and what happened, and it is empty on a healthy Service —
 * where it is not drawn at all rather than drawn empty.
 *
 * This replaces the Pods tab rather than sitting beside it. That tab listed
 * the pods the selector matched, which is the Selector tab's own rule
 * enumerated; *selected*, *ready* and *published* are three different sets,
 * and two answers to "what is behind this Service" one click apart is exactly
 * how a reader ends up on the wrong one.
 */

import { Section, SectionHeader } from "@/components/ui/section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { ResourceRef } from "./ResourceRef";
import { ResourceType } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import {
  endpointAddress,
  endpointState,
  publishedFor,
  publishedSummary,
  sourceNote,
  topologyNote,
  unpublishedNote,
} from "@/lib/published";
import { useState } from "react";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { ObjectRef, ServicePublished } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

/** How many rows are worth drawing before the reader has to ask for more.
 *  1240 rows is not an answer; the count and the disagreements are. */
const SHOWN = 12;

const TONE: Record<"ok" | "warn" | "err", string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
};

export function PublishedEndpoints({
  query,
  service,
}: {
  query: ConnectionsQuery;
  service: ObjectRef;
}) {
  const t = useT();
  const { data, isPending, error } = query;

  if (isPending) {
    return (
      <p className="text-xs text-fg-fnt">
        {t("empty", "readingWhatServicePublishes")}
      </p>
    );
  }
  if (error || !data) {
    return (
      <p className="text-xs text-err">
        {t("empty", "couldNotReadWhatServicePublishes")}{" "}
        {error?.message ?? t("empty", "noAnswer")}
      </p>
    );
  }
  const published = publishedFor(data, service);
  if (!published) {
    return (
      <p className="text-xs text-fg-fnt">
        <T section="empty" k="nothingReadForService" />
      </p>
    );
  }
  return <Lists published={published} />;
}

function Lists({ published }: { published: ServicePublished }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const rows = all ? published.endpoints : published.endpoints.slice(0, SHOWN);
  const hidden = published.endpoints.length - rows.length;
  const topology = topologyNote(published);
  const source = sourceNote(published);
  const zoned = published.endpoints.some((endpoint) => endpoint.zone !== null);

  return (
    <div className="flex flex-col gap-6">
      <Section>
        <SectionHeader
          title="Published"
          count={publishedSummary(published)}
          description={source ?? undefined}
          actions={
            hidden > 0 || all ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px]"
                onClick={() => setAll(!all)}
              >
                {all
                  ? t("action", "showFewer")
                  : t("action", "showAll", { n: published.endpoints.length })}
              </Button>
            ) : undefined
          }
        />
        {published.endpoints.length === 0 ? (
          <p className="text-xs text-fg-fnt">
            <T section="empty" k="servicePublishesNothing" />
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns", "address")}</TableHead>
                <TableHead>Pod</TableHead>
                <TableHead>{t("columns", "state")}</TableHead>
                <TableHead>{t("columns", "node")}</TableHead>
                {zoned && <TableHead>{t("columns", "zone")}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((endpoint) => {
                const state = endpointState(endpoint);
                return (
                  <TableRow key={endpoint.address} data-quiet>
                    <TableCell>
                      <CopyableAddress
                        value={endpointAddress(endpoint)}
                        label="Address"
                      />
                    </TableCell>
                    <TableCell>
                      {endpoint.target ? (
                        <ResourceRef
                          kind={endpoint.target.kind}
                          name={endpoint.target.name}
                          namespace={endpoint.target.namespace}
                          showKind={endpoint.target.kind !== ResourceType.Pod}
                        />
                      ) : (
                        // A hand-written slice names no pod, and that is a
                        // state rather than a gap in the reading.
                        <span className="text-fg-fnt">
                          {t("empty", "registeredByHand")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className={cn("text-[11px]", TONE[state.tone])}>
                      {state.text}
                    </TableCell>
                    <TableCell>
                      {endpoint.nodeName ? (
                        <ResourceRef
                          kind={ResourceType.Node}
                          name={endpoint.nodeName}
                          showKind={false}
                        />
                      ) : (
                        <span className="text-fg-fnt">—</span>
                      )}
                    </TableCell>
                    {zoned && (
                      <TableCell className="font-mono text-fg-mut">
                        {endpoint.zone ?? "—"}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {hidden > 0 && (
          <p className="text-[11px] text-fg-fnt">
            {t("count", "moreNotDrawn", { n: hidden })}
          </p>
        )}
      </Section>

      {published.unpublished.length > 0 && (
        <Section>
          <SectionHeader
            title="Matches the selector, not published"
            count={
              <span className="text-err">{published.unpublished.length}</span>
            }
          />
          <Table>
            <TableBody>
              {published.unpublished.map((entry) => (
                <TableRow key={entry.pod.name} data-quiet>
                  <TableCell className="w-[1%] whitespace-nowrap">
                    <ResourceRef
                      kind={ResourceType.Pod}
                      name={entry.pod.name}
                      namespace={entry.pod.namespace}
                      showKind={false}
                    />
                  </TableCell>
                  <TableCell className="text-err">
                    {unpublishedNote(entry)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {topology && (
        <Section>
          <SectionHeader title="Topology" />
          <p className="text-xs text-fg-mut">{topology}</p>
        </Section>
      )}

      {published.ports.some((port) => !port.exposed) && (
        <Section>
          <SectionHeader
            title="Ports the Service does not expose"
            description="A slice carries a port by the Service port's name. These name none it declares, so nothing routes to them."
          />
          <p className="font-mono text-xs text-fg-mut">
            {published.ports
              .filter((port) => !port.exposed)
              .map(
                (port) => `${port.name ?? "unnamed"} → ${port.port ?? "all"}`
              )
              .join(" · ")}
          </p>
        </Section>
      )}
    </div>
  );
}
