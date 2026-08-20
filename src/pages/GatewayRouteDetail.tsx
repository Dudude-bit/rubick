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

import { Info, Route as RouteGlyph, Tag, Trash2 } from "lucide-react";

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
import { ClickableServicePort } from "@/components/ui/clickable-port";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { RouteTraceSection } from "@/components/resources/RouteTrace";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useResourceDetail } from "@/hooks";
import { useT, type T } from "@/i18n/useT";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { backingOf, useBackingLists } from "@/integrations";
import { describeStop } from "@/lib/connections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import type {
  EventFilters,
  RouteInfo,
  RouteMatchInfo,
  RouteRuleInfo,
} from "@/generated/types";

/** One match, in the kind's own vocabulary. */
function sayMatch(match: RouteMatchInfo, t: T): string {
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
  parts.push(...match.queryParams.map((param) => `?${param}`));
  return parts.length > 0
    ? parts.join(" · ")
    : t("empty", "matchesEverythingWord");
}

function RuleRows({ route }: { route: RouteInfo }) {
  const t = useT();
  const backing = useBackingLists();

  return (
    <Section>
      <SectionHeader title={t("columns", "rules")} count={route.rules.length} />
      {route.rules.length === 0 ? (
        <p className="text-xs text-fg-fnt">{t("empty", "gwNoRules")}</p>
      ) : (
        <div className="space-y-3">
          {route.rules.map((rule: RouteRuleInfo, index: number) => (
            <div key={index} className="rounded border border-hair px-3 py-2">
              <div className="text-xs text-fg-mut">
                {rule.matches.length === 0 ? (
                  <span className="text-fg-fnt">
                    {t("empty", "matchesEverything")}
                  </span>
                ) : (
                  rule.matches.map((match, at) => (
                    <span key={at} className="mr-2 font-mono">
                      {sayMatch(match, t)}
                    </span>
                  ))
                )}
              </div>
              {rule.extensionRefs.length > 0 && (
                <p className="pt-1 text-xs text-fg-fnt">
                  {/* Named, never guessed at: what a vendor filter means is
                      the vendor's business; that it is here is ours. */}
                  {t("empty", "gwUninterpretedFilters")}{" "}
                  <span className="font-mono">
                    {rule.extensionRefs
                      .map((ref) => `${ref.kind}.${ref.group}/${ref.name}`)
                      .join(", ")}
                  </span>
                </p>
              )}
              {rule.hasRedirect && rule.backendRefs.length === 0 ? (
                <p className="pt-1 text-xs text-fg-mut">
                  {t("empty", "gwRedirectsNoBackends")}
                </p>
              ) : rule.backendRefs.length === 0 ? (
                <p className="pt-1 text-xs text-warn">
                  {t("empty", "gwNoBackendRefsSay")}.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columns", "backend")}</TableHead>
                      <TableHead>{t("columns", "port")}</TableHead>
                      <TableHead>{t("columns", "weight")}</TableHead>
                      <TableHead>{t("columns", "behindIt")}</TableHead>
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
                                  {" · "}
                                  {t("action", "inInline")}{" "}
                                  <ResourceRef
                                    kind="Namespace"
                                    name={backend.namespace}
                                    showKind={false}
                                  />{" "}
                                  — {t("empty", "needsReferenceGrant")}
                                </span>
                              )}
                          </TableCell>
                          <TableCell className="font-mono text-fg-mut">
                            {backend.kind === "Service" &&
                            backend.port != null ? (
                              <ClickableServicePort
                                port={backend.port}
                                serviceName={backend.name}
                                namespace={namespace}
                              />
                            ) : (
                              (backend.port ?? "—")
                            )}
                          </TableCell>
                          <TableCell className="text-fg-fnt">
                            {backend.weight === 0
                              ? t("empty", "zeroWeight")
                              : (backend.weight ?? "—")}
                          </TableCell>
                          <TableCell className="text-xs">
                            {state === null ? (
                              <span className="text-fg-fnt">—</span>
                            ) : !state.known ? (
                              <span className="text-fg-fnt">
                                {t("action", "readingInline")}
                              </span>
                            ) : state.stop ? (
                              <span className="text-err">
                                {describeStop(state.stop).title}
                              </span>
                            ) : state.service?.type === "ExternalName" ? (
                              <span className="text-fg-mut">
                                {t("empty", "resolvesElsewhereExternal")}
                              </span>
                            ) : (
                              <span className="text-ok">
                                {t("count", "nReady", { n: state.ready })}
                                {state.draining > 0 &&
                                  `, ${t("count", "nDraining", {
                                    n: state.draining,
                                  })}`}
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
  const t = useT();
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
    deleteMutation,
    freshness,
  } = useResourceDetail<RouteInfo>({
    resourceKind: kind,
    fetchResource: (name, ns) => commands.getGatewayRoute(kind, name, ns),
    deleteResource: (name, ns) => commands.deleteGatewayRoute(kind, name, ns),
    defaultTab: "overview",
  });

  const deliveryQuery = deliveryOfKind(kind, route ?? undefined);
  const intercept = useDeliveryIntercept(deliveryQuery);

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
      label: t("columns", "hostnames"),
      value: (
        <CopyableAddresses
          values={route?.hostnames ?? []}
          label={t("columns", "hostname")}
          empty={t("empty", "gwAllHostsListenerServes")}
        />
      ),
    },
    ...(route && !route.apiVersion.endsWith("/v1")
      ? [
          {
            label: t("columns", "readAt"),
            value: route.apiVersion,
            tone: "warn" as const,
          },
        ]
      : []),
  ];

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
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
      label: t("columns", "rules"),
      glyph: viewGlyph(RouteGlyph),
      mark: countMark(route?.rules.length ?? 0),
      content: route ? <RuleRows route={route} /> : null,
    },
    {
      id: "metadata",
      label: t("nav", "metadata"),
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(route?.labels ?? {}).length}
            items={recordToKeyValues(route?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(route?.annotations ?? {}).length}
            items={recordToKeyValues(route?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
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
      delivery={deliveryQuery}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
          label={t("action", "delete")}
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
        />
      }
    />
  );
}
