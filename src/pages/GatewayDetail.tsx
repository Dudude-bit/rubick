/**
 * A Gateway, read as the thing that serves: its listeners — its own and the
 * ones ListenerSets contribute, told apart — the addresses a controller
 * gave it, and the routes attached to it, each with that controller's own
 * verdict.
 *
 * The class claim is drawn with its three honest states: claimed, refused,
 * and the one that ruins clusters quietly — a GatewayClass nothing ever
 * answered for, which is not an error anywhere and serves no traffic.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Route as RouteGlyph, Tag } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CopyableAddresses,
  CopyableValue,
} from "@/components/ui/copyable-value";
import { Section, SectionHeader } from "@/components/ui/section";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  countMark,
  kindGlyph,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { EventRows } from "@/components/resources/detail-blocks";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { CertificateLine } from "@/components/resources/CertificateFacts";
import { useResourceDetail } from "@/hooks";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useTlsCertificates } from "@/hooks/useTlsCertificates";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import type {
  EventFilters,
  GatewayInfo,
  ListenerInfo,
  RouteInfo,
} from "@/generated/types";

/** A minute: routing changes with a deploy, not by the second. */
const ROUTING_STALE = 60_000;

const ROUTE_KINDS = new Set([
  "HTTPRoute",
  "GRPCRoute",
  "TLSRoute",
  "TCPRoute",
  "UDPRoute",
]);

/**
 * Whether this route names that Gateway as a parent — namespace resolved
 * the way the API resolves it: an absent parentRef namespace means the
 * route's own.
 */
function attachesTo(route: RouteInfo, gateway: GatewayInfo): boolean {
  return route.parentRefs.some(
    (parent) =>
      parent.kind === "Gateway" &&
      parent.name === gateway.name &&
      (parent.namespace ?? route.namespace) === gateway.namespace
  );
}

/** The Accepted verdict this Gateway's controllers gave one route. */
function acceptedBy(
  route: RouteInfo,
  gateway: GatewayInfo
): { text: string; tone: "ok" | "err" | "mute" } {
  const verdicts = route.parents
    .filter(
      (parent) =>
        parent.parent.name === gateway.name &&
        (parent.parent.namespace ?? route.namespace) === gateway.namespace
    )
    .flatMap((parent) =>
      parent.conditions.filter((c) => c.type === "Accepted")
    );
  if (verdicts.length === 0)
    return { text: "no controller answered", tone: "mute" };
  const refused = verdicts.find((c) => c.status === "False");
  if (refused) return { text: refused.reason ?? "refused", tone: "err" };
  if (verdicts.every((c) => c.status === "True"))
    return { text: "accepted", tone: "ok" };
  return { text: "unknown", tone: "mute" };
}

const TONE_CLASS = {
  ok: "text-ok",
  err: "text-err",
  mute: "text-fg-fnt",
} as const;

function ListenerRows({ gateway }: { gateway: GatewayInfo }) {
  // Certificates a listener names in the Gateway's own namespace are read;
  // a cross-namespace ref is named and left to the listener's ResolvedRefs
  // condition — whether a ReferenceGrant allows it is the controller's
  // verdict, not this page's guess.
  const ownSecrets = gateway.listeners.flatMap((listener) =>
    listener.certificateRefs
      .filter((ref) => ref.namespace === null)
      .map((ref) => ref.name)
  );
  const certificates = useTlsCertificates(gateway.namespace, ownSecrets);

  const broken = (listener: ListenerInfo) =>
    listener.conditions.some((c) => c.status === "False");

  return (
    <Section>
      <SectionHeader title="Listeners" count={gateway.listeners.length} />
      {gateway.listeners.length === 0 ? (
        <p className="text-xs text-fg-fnt">
          No listeners — this Gateway accepts no traffic, and no route can
          attach to it.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Protocol</TableHead>
              <TableHead>Port</TableHead>
              <TableHead>Hostname</TableHead>
              <TableHead>TLS</TableHead>
              <TableHead>Routes from</TableHead>
              <TableHead>Attached</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {gateway.listeners.map((listener) => (
              <TableRow
                key={`${listener.fromListenerSet ?? ""}/${listener.name}`}
                data-quiet
              >
                <TableCell className="text-fg-mut">
                  {listener.name}
                  {listener.fromListenerSet && (
                    <span className="text-fg-fnt">
                      {" "}
                      · from {listener.fromListenerSet}
                    </span>
                  )}
                  {broken(listener) && (
                    <span className="text-err">
                      {" "}
                      ·{" "}
                      {listener.conditions.find((c) => c.status === "False")
                        ?.reason ?? "broken"}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-fg-fnt">
                  {listener.protocol}
                </TableCell>
                <TableCell className="font-mono text-fg">
                  {listener.port}
                </TableCell>
                <TableCell className="font-mono text-fg-mut">
                  {/* An unset hostname is the catch-all, and saying so beats
                      an empty cell that reads as "serves nothing". */}
                  {listener.hostname ? (
                    <CopyableValue
                      value={listener.hostname}
                      label={`Listener hostname ${listener.hostname}`}
                      className="text-xs"
                    />
                  ) : (
                    "all hosts"
                  )}
                </TableCell>
                <TableCell>
                  {listener.tlsMode === null ? (
                    <span className="text-fg-fnt">—</span>
                  ) : (
                    <span className="text-fg-mut">
                      {listener.tlsMode}
                      {listener.certificateRefs.map((ref) =>
                        ref.namespace === null ? (
                          <CertificateLine
                            key={ref.name}
                            read={certificates.data?.get(ref.name)}
                            hosts={listener.hostname ? [listener.hostname] : []}
                          />
                        ) : (
                          <span
                            key={`${ref.namespace}/${ref.name}`}
                            className="block text-fg-fnt"
                          >
                            <ResourceRef
                              kind="Namespace"
                              name={ref.namespace!}
                              showKind={false}
                            />
                            /
                            <ResourceRef
                              kind="Secret"
                              name={ref.name}
                              namespace={ref.namespace}
                              showKind={false}
                            />{" "}
                            — cross-namespace, needs a ReferenceGrant
                          </span>
                        )
                      )}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-fg-fnt">
                  {/* The spec default is Same; kept as written, because an
                      absent field is the API's default and not something a
                      controller said. */}
                  {listener.allowedNamespaces ?? "Same (default)"}
                </TableCell>
                <TableCell className="font-mono text-fg-mut">
                  {listener.attachedRoutes ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function GatewayDetail() {
  const {
    name,
    namespace,
    resource: gateway,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
  } = useResourceDetail<GatewayInfo>({
    resourceKind: ResourceType.Gateway,
    fetchResource: (name, ns) => commands.getGateway(name, ns),
    deleteResource: (name, ns) => commands.deleteGateway(name, ns),
    defaultTab: "overview",
  });

  const detection = useGatewayApi().data;

  // The class claim, resolved the way IngressClass claiming is: the class
  // carries the controller that answers for it, and Accepted is that
  // controller's signature. Unknown or absent is the honest third state.
  const classes = useQuery({
    queryKey: ["gateway-classes"],
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    enabled: !!gateway,
  });
  const gatewayClass = classes.data?.find(
    (entry) => entry.name === gateway?.className
  );

  // Every route of every served kind, unscoped: routes attach across
  // namespaces, and a namespace-scoped list would call them absent.
  const routeKinds = (detection?.kinds ?? [])
    .map((kind) => kind.kind)
    .filter((kind) => ROUTE_KINDS.has(kind));
  const routes = useQuery({
    queryKey: ["gateway-attached-routes", ...routeKinds],
    queryFn: async () => {
      const lists = await Promise.all(
        routeKinds.map((kind) => commands.listGatewayRoutes(kind, null))
      );
      return lists.flat();
    },
    staleTime: ROUTING_STALE,
    enabled: routeKinds.length > 0,
  });
  const attached = useMemo(
    () =>
      gateway
        ? (routes.data ?? []).filter((route) => attachesTo(route, gateway))
        : [],
    [routes.data, gateway]
  );

  const { data: events = [] } = useLiveQuery({
    queryKey: ["gateway-events", namespace, name],
    queryFn: async () => {
      const filters: EventFilters = {
        namespace: namespace || null,
        involved_object_name: name || null,
        involved_object_kind: ResourceType.Gateway,
        event_type: null,
        field_selector: null,
        limit: 100,
      };
      return await commands.listEvents(filters);
    },
    enabled: !!name && !!namespace,
    refresh: "overview",
  });

  if (!gateway && !isLoading && !error) {
    return null;
  }

  const programmed = gateway?.conditions.find((c) => c.type === "Programmed");

  const classFact: KeyValue = (() => {
    // The name is a reference only where the object is there to open —
    // "no such GatewayClass" linking to a 404 would undercut its own words.
    const named = (tail: string) => (
      <span className="inline-flex flex-wrap items-baseline gap-x-1">
        <ResourceRef
          kind={ResourceType.GatewayClass}
          name={gateway?.className ?? ""}
          showKind={false}
        />
        <span>{tail}</span>
      </span>
    );
    if (!classes.data || !gateway) {
      return { label: "Class", value: gateway?.className || "—" };
    }
    if (!gatewayClass) {
      return {
        label: "Class",
        value: `${gateway.className || "—"} — no such GatewayClass`,
        tone: "err" as const,
      };
    }
    if (gatewayClass.accepted === true) {
      return {
        label: "Class",
        value: named(`— claimed by ${gatewayClass.controllerName}`),
      };
    }
    if (gatewayClass.accepted === false) {
      return {
        label: "Class",
        value: named(`— refused by ${gatewayClass.controllerName}`),
        tone: "err" as const,
      };
    }
    return {
      label: "Class",
      value: named("— no controller has claimed this class"),
      tone: "warn" as const,
    };
  })();

  const facts: KeyValue[] = [
    classFact,
    {
      label: "Programmed",
      value: programmed
        ? programmed.status === "True"
          ? "yes"
          : (programmed.reason ?? programmed.status)
        : "no controller answered",
      tone: programmed
        ? programmed.status === "True"
          ? undefined
          : ("err" as const)
        : ("warn" as const),
    },
    {
      label: "Addresses",
      value: (
        <CopyableAddresses
          values={gateway?.addresses ?? []}
          label="Gateway address"
          empty="none published"
        />
      ),
    },
    // The version this object was actually read at, said only where it is
    // not the current one — an old bundle is a fact about the cluster the
    // reader should not have to discover in a diff.
    ...(gateway && !gateway.apiVersion.endsWith("/v1")
      ? [
          {
            label: "Read at",
            value: gateway.apiVersion,
            tone: "warn" as const,
          },
        ]
      : []),
    ...(detection?.mixedBundle
      ? [
          {
            label: "CRD bundle",
            value:
              "mixed versions — a partial upgrade left Gateway API CRDs from different releases",
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
          <KeyValueSection title="Gateway" items={facts} className="max-w-lg" />
          {gateway && <ListenerRows gateway={gateway} />}
        </>
      ),
    },
    {
      id: "routes",
      label: "Routes",
      glyph: viewGlyph(RouteGlyph),
      mark: countMark(attached.length),
      content: (
        <Section>
          <SectionHeader title="Attached routes" count={attached.length} />
          {routeKinds.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              The cluster serves no route kinds, so nothing can attach here.
            </p>
          ) : routes.isLoading ? (
            <p className="text-xs text-fg-fnt">Reading routes…</p>
          ) : routes.isError ? (
            <p className="text-xs text-err">
              The routes could not be read — whether anything attaches here is
              not known, which is not the same as "nothing does".
            </p>
          ) : attached.length === 0 ? (
            <p className="text-xs text-fg-fnt">
              No route names this Gateway. Its listeners answer, and every
              request meets whatever the controller serves for an unmatched
              host.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Hostnames</TableHead>
                  <TableHead>Accepted</TableHead>
                  <TableHead>Rules</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attached.map((route) => {
                  const verdict = gateway
                    ? acceptedBy(route, gateway)
                    : ({ text: "—", tone: "mute" } as const);
                  return (
                    <TableRow
                      key={`${route.kind}/${route.namespace}/${route.name}`}
                      data-quiet
                    >
                      <TableCell className="text-fg-fnt">
                        {route.kind}
                      </TableCell>
                      <TableCell>
                        <ResourceRef
                          kind={route.kind}
                          name={route.name}
                          namespace={route.namespace}
                          showKind={false}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-fg-mut">
                        {route.hostnames.length > 0
                          ? route.hostnames.join(", ")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <span className={TONE_CLASS[verdict.tone]}>
                          {verdict.text}
                        </span>
                      </TableCell>
                      <TableCell className="text-fg-fnt">
                        {route.rules.length}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Section>
      ),
    },
    {
      id: "metadata",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(gateway?.labels ?? {}).length}
            items={recordToKeyValues(gateway?.labels ?? {})}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(gateway?.annotations ?? {}).length}
            items={recordToKeyValues(gateway?.annotations ?? {})}
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
      title: "Gateway YAML",
      yaml,
      resourceKind: ResourceType.Gateway,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={gateway}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Gateway}
      title={gateway?.name || ""}
      namespace={gateway?.namespace}
      createdAt={gateway?.createdAt}
      badges={
        gateway && (
          <span className="text-[11px] text-fg-mut">{gateway.className}</span>
        )
      }
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
