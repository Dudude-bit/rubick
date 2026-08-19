/**
 * One detail page for the five route kinds, because the object is one
 * shape: parentRefs up, rules with backendRefs down, and a status written
 * per (parent, controller). What differs — path matches, gRPC methods, SNI
 * hostnames — is a row's wording, not a page's structure.
 *
 * Two sources of truth, drawn in their order of trust: the conditions each
 * controller wrote for each parent, then what every backend's Service
 * actually publishes — the same `backingOf` every routing page in the app
 * reads, so a route broken here is broken there in the same words.
 */

import { Info, Route as RouteGlyph, Tag } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  countMark,
  kindGlyph,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { EventRows } from "@/components/resources/detail-blocks";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { RouteTraceSection } from "@/components/resources/RouteTrace";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { backingOf, useBackingLists } from "@/integrations";
import { describeStop } from "@/lib/connections";
import { commands } from "@/lib/commands";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import type {
  EventFilters,
  RouteInfo,
  RouteMatchInfo,
  RouteRuleInfo,
} from "@/generated/types";

/** One match, in the kind's own vocabulary. */
function sayMatch(match: RouteMatchInfo): string {
  const parts: string[] = [];
  if (match.path) {
    parts.push(
      match.pathType === "Exact" ? `= ${match.path}` : `${match.path}…`
    );
  }
  if (match.method) parts.push(match.method);
  if (match.grpcService || match.grpcMethod) {
    parts.push([match.grpcService ?? "*", match.grpcMethod ?? "*"].join("/"));
  }
  parts.push(...match.headers);
  return parts.length > 0 ? parts.join(" · ") : "everything";
}

function RuleRows({ route }: { route: RouteInfo }) {
  const backing = useBackingLists();

  return (
    <Section>
      <SectionHeader title="Rules" count={route.rules.length} />
      {route.rules.length === 0 ? (
        <p className="text-xs text-fg-fnt">No rules — nothing is matched.</p>
      ) : (
        <div className="space-y-3">
          {route.rules.map((rule: RouteRuleInfo, index: number) => (
            <div key={index} className="rounded border border-hair px-3 py-2">
              <div className="text-xs text-fg-mut">
                {rule.matches.length === 0 ? (
                  <span className="text-fg-fnt">matches everything</span>
                ) : (
                  rule.matches.map((match, at) => (
                    <span key={at} className="mr-2 font-mono">
                      {sayMatch(match)}
                    </span>
                  ))
                )}
              </div>
              {rule.extensionRefs.length > 0 && (
                <p className="pt-1 text-xs text-fg-fnt">
                  {/* Named, never guessed at: what a vendor filter means is
                      the vendor's business; that it is here is ours. */}
                  filters this app does not interpret:{" "}
                  <span className="font-mono">
                    {rule.extensionRefs
                      .map((ref) => `${ref.kind}.${ref.group}/${ref.name}`)
                      .join(", ")}
                  </span>
                </p>
              )}
              {rule.hasRedirect && rule.backendRefs.length === 0 ? (
                <p className="pt-1 text-xs text-fg-mut">
                  Redirects — no backends, and none needed.
                </p>
              ) : rule.backendRefs.length === 0 ? (
                <p className="pt-1 text-xs text-warn">
                  No backendRefs — a matched request has nowhere to go.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Backend</TableHead>
                      <TableHead>Port</TableHead>
                      <TableHead>Weight</TableHead>
                      <TableHead>Behind it</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rule.backendRefs.map((backend, at) => {
                      const namespace = backend.namespace ?? route.namespace;
                      const state =
                        backend.kind === "Service"
                          ? backingOf(
                              { name: backend.name, namespace },
                              {
                                kind: route.kind,
                                name: route.name,
                                namespace: route.namespace,
                              },
                              {
                                services: backing.data?.services ?? [],
                                published: backing.data?.published ?? [],
                                backingKnown: backing.data !== undefined,
                              }
                            )
                          : null;
                      return (
                        <TableRow key={at} data-quiet>
                          <TableCell>
                            {backend.kind === "Service" ? (
                              <ResourceRef
                                kind={ResourceType.Service}
                                name={backend.name}
                                namespace={namespace}
                                showKind={false}
                              />
                            ) : (
                              <span className="font-mono text-fg-mut">
                                {backend.kind} {backend.name}
                              </span>
                            )}
                            {backend.namespace &&
                              backend.namespace !== route.namespace && (
                                <span className="text-fg-fnt">
                                  {" "}
                                  · in {backend.namespace} — needs a
                                  ReferenceGrant
                                </span>
                              )}
                          </TableCell>
                          <TableCell className="font-mono text-fg-mut">
                            {backend.port ?? "—"}
                          </TableCell>
                          <TableCell className="text-fg-fnt">
                            {backend.weight === 0
                              ? "0 — receives no traffic"
                              : (backend.weight ?? "—")}
                          </TableCell>
                          <TableCell className="text-xs">
                            {state === null ? (
                              <span className="text-fg-fnt">—</span>
                            ) : !state.known ? (
                              <span className="text-fg-fnt">reading…</span>
                            ) : state.stop ? (
                              <span className="text-err">
                                {describeStop(state.stop).title}
                              </span>
                            ) : state.service?.type === "ExternalName" ? (
                              <span className="text-fg-mut">
                                resolves elsewhere (ExternalName)
                              </span>
                            ) : (
                              <span className="text-ok">
                                {state.ready} ready
                                {state.draining > 0 &&
                                  `, ${state.draining} draining`}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export function GatewayRouteDetail({ kind }: { kind: ResourceKind }) {
  const {
    name,
    namespace,
    resource: route,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
  } = useResourceDetail<RouteInfo>({
    resourceKind: kind,
    fetchResource: (name, ns) => commands.getGatewayRoute(kind, name, ns),
    deleteResource: (name, ns) => commands.deleteGatewayRoute(kind, name, ns),
    defaultTab: "overview",
  });

  const { data: events = [] } = useLiveQuery({
    queryKey: ["gateway-route-events", kind, namespace, name],
    queryFn: async () => {
      const filters: EventFilters = {
        namespace: namespace || null,
        involved_object_name: name || null,
        involved_object_kind: kind,
        event_type: null,
        field_selector: null,
        limit: 100,
      };
      return await commands.listEvents(filters);
    },
    enabled: !!name && !!namespace,
    refresh: "overview",
  });

  if (!route && !isLoading && !error) {
    return null;
  }

  const facts: KeyValue[] = [
    {
      label: "Hostnames",
      value: (
        <CopyableAddresses
          values={route?.hostnames ?? []}
          label="Hostname"
          empty="all hosts the listener serves"
        />
      ),
    },
    ...(route && !route.apiVersion.endsWith("/v1")
      ? [
          {
            label: "Read at",
            value: route.apiVersion,
            tone: "warn" as const,
          },
        ]
      : []),
  ];

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection title={kind} items={facts} className="max-w-lg" />
          {route && <RouteTraceSection route={route} />}
        </>
      ),
    },
    {
      id: "rules",
      label: "Rules",
      glyph: viewGlyph(RouteGlyph),
      mark: countMark(route?.rules.length ?? 0),
      content: route ? <RuleRows route={route} /> : null,
    },
    {
      id: "metadata",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(route?.labels ?? {}).length}
            items={recordToKeyValues(route?.labels ?? {})}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(route?.annotations ?? {}).length}
            items={recordToKeyValues(route?.annotations ?? {})}
            emptyMessage="No annotations"
          />
        </>
      ),
    },
    {
      id: "events",
      label: "Events",
      glyph: kindGlyph(ResourceType.Event),
      mark: countMark(events.length),
      content: <EventRows events={events} />,
    },
    yamlTab({
      title: `${kind} YAML`,
      yaml,
      resourceKind: kind,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={route}
      isLoading={isLoading}
      error={error}
      resourceKind={kind}
      title={route?.name || ""}
      namespace={route?.namespace}
      createdAt={route?.createdAt}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
