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
import { DeleteAction } from "../../../-object/DeleteAction";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Section, SectionHeader } from "@/components/ui/section";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/object/detail-tab";
import { ClickableServicePort } from "@/components/ui/clickable-port";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import { ResourceRef } from "@/components/object/ResourceRef";
import { RouteTraceSection } from "./RouteTrace";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { useResourceDetail } from "@/hooks";
import { useT } from "@/i18n/useT";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { useGatewayRouteShare } from "./useGatewayRouteShare";
import { backingOf } from "@/integrations";
import { useRouteBacking } from "./useRouteBacking";
import { ChainWatches } from "../../../-object/ChainWatches";
import { describeStop, stopMood, type StopMood } from "@/lib/connections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { sayMatch } from "@/lib/route-match";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import type { RouteInfo, RouteRuleInfo } from "@/generated/types";
import { None } from "@/components/ui/none";

/** A backend's stop as the chain colours it: only a fault is red. */
const STOP_TEXT: Record<StopMood, string> = {
  fault: "text-err",
  coming: "text-info",
  idle: "text-fg-mut",
  unchecked: "text-fg-mut",
};

function RuleRows({ route }: { route: RouteInfo }) {
  const t = useT();
  const backing = useRouteBacking(route, false).sources;

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
              ) : rule.extensionRefs.length > 0 &&
                rule.backendRefs.length === 0 ? (
                <p className="pt-1 text-xs text-fg-mut">
                  {t("empty", "gwFilterNoBackends")}
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
                              backing
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
                                  ({t("empty", "needsReferenceGrant")})
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
                              (backend.port ?? <None />)
                            )}
                          </TableCell>
                          <TableCell className="text-fg-fnt">
                            {backend.weight === 0
                              ? t("empty", "zeroWeight")
                              : (backend.weight ?? t("action", "notSet"))}
                          </TableCell>
                          <TableCell className="text-xs">
                            {state === null ? (
                              <span className="text-fg-fnt">
                                {t("cluster", "markUnchecked")}
                              </span>
                            ) : !state.known ? (
                              <span className="text-fg-fnt">
                                {t("action", "readingInline")}
                              </span>
                            ) : state.stop ? (
                              <span className={STOP_TEXT[stopMood(state.stop)]}>
                                {describeStop(state.stop, t).title}
                              </span>
                            ) : state.service?.type === "ExternalName" ? (
                              <span className="text-fg-mut">
                                {t("empty", "resolvesElsewhereExternal")}
                              </span>
                            ) : state.ready === 0 && state.draining > 0 ? (
                              <span className="text-warn">
                                {t("count", "nDraining", {
                                  n: state.draining,
                                })}
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
  const share = useGatewayRouteShare(route);

  const events = useObjectEvents(kind, name, namespace, {
    refresh: "overview",
  });
  const backing = useRouteBacking(route, true);

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
    eventsTab(events, t, { kind, name: name ?? "" }),
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
    <>
      <ChainWatches services={backing.services} reads={[backing.key]} />
      <ResourceDetailLayout
        freshness={freshness}
        resource={route}
        share={share}
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
          <DeleteAction
            kind={kind}
            name={route?.name || ""}
            namespace={route?.namespace}
            detail={route}
            intercept={intercept("Delete")}
            mutation={deleteMutation}
          />
        }
      />
    </>
  );
}
