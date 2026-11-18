/**
 * What the installed integrations add to the map: who delivered an object
 * (an Argo CD Application, a Flux Kustomization) and which vendor objects
 * route into a Service (a Traefik IngressRoute). Merged at render, never into
 * what the backend sent: a vendor only ever adds.
 */

import { useMemo } from "react";

import type { TopologyNode } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { AppLink } from "@/lib/links";
import { kindFacts } from "@/lib/resource-registry";
import type { Delivery, DeliveryQuery, ServiceRoute } from "@/integrations";
import { errorToShow } from "@/lib/error-utils";
import { useServicesRoutes } from "@/hooks/useServiceRoutes";
import { useDeliveries } from "../-delivery/useDelivery";
import { nodeId } from "../-map/ids";
import type { TopologySnapshot } from "../-map/useTopology";
import type { GraphEdge, GraphNode } from "../-map/types";

export interface VendorNode {
  node: GraphNode;
  /** Where its page is; a vendor object has no peek of its own here. */
  page: AppLink | null;
  /** For a vendor object with a CRD the app knows, its peek. */
  peek: { kind: string; name: string; namespace: string; crd: string } | null;
}

export interface VendorLayers {
  nodes: VendorNode[];
  edges: GraphEdge[];
  /** A vendor that is installed and did not answer, in its own words. */
  unread: string[];
}

const groupOfCrd = (crd: string | undefined) =>
  crd ? crd.slice(crd.indexOf(".") + 1) : null;

function deliveredBy(delivery: Delivery) {
  if (delivery.state === "delivered") return delivery.source;
  return null;
}

const NO_SERVICES: readonly { namespace: string; name: string }[] = [];

/**
 * The delivery owners of every object the map holds, asked once for all of
 * them, and the vendor routes into the Services of the groups drawn open.
 * Nothing is asked until the map's current stream has drawn it whole: each
 * batch before it, a reopen's included, would have asked the vendors about
 * the whole cluster again.
 */
export function useVendorLayers(
  map: Pick<TopologySnapshot, "nodes" | "phase">,
  openServices: readonly { namespace: string; name: string }[],
  /** The group a namespace's objects are drawn in, `null` where none is. */
  groupOf: (namespace: string) => string | null,
  t: T
): VendorLayers {
  const { nodes } = map;
  const whole = map.phase === "ready" || map.phase === "ended";
  const asked = whole ? openServices : NO_SERVICES;
  const queries = useMemo<DeliveryQuery[]>(
    () =>
      [...(whole ? nodes : new Map<string, TopologyNode>()).values()]
        .filter(
          (node) =>
            Object.keys(node.labels).length > 0 ||
            Object.keys(node.annotations).length > 0
        )
        .map((node) => ({
          group: node.ref.group ?? kindFacts(node.ref.kind)?.group ?? "",
          kind: node.ref.kind,
          name: node.ref.name,
          namespace: node.ref.namespace ?? null,
          labels: node.labels,
          annotations: node.annotations,
        })),
    [nodes, whole]
  );
  const deliveries = useDeliveries(queries);
  const routes = useServicesRoutes(
    asked as { namespace: string; name: string }[]
  );
  // Built every render: `useDeliveries` answers with a new reader each time,
  // and this is one pass over objects already in memory.
  return layersOf({
    queries,
    deliveries: { of: deliveries.of, error: deliveries.error },
    services: asked,
    routes: { of: routes.routes, error: routes.error },
    groupOf,
    t,
  });
}

/** The vendor layers from the answers the integrations gave. */
export function layersOf({
  queries,
  deliveries,
  services,
  routes,
  groupOf,
  t,
}: {
  queries: readonly DeliveryQuery[];
  deliveries: { of: (query: DeliveryQuery) => Delivery[]; error: Error | null };
  services: readonly { namespace: string; name: string }[];
  routes: { of: ReadonlyMap<string, ServiceRoute[]>; error: Error | null };
  groupOf: (namespace: string) => string | null;
  t: T;
}): VendorLayers {
  const openServices = services;
  {
    const drawn = new Map<string, VendorNode>();
    const edges = new Map<string, GraphEdge>();
    for (const query of queries) {
      const target = nodeId(query);
      for (const delivery of deliveries.of(query)) {
        const source = deliveredBy(delivery);
        if (!source) continue;
        const { owner } = source;
        const id = `delivery:${source.vendorId}/${owner.kind}/${owner.namespace}/${owner.name}`;
        if (!drawn.has(id))
          drawn.set(id, {
            node: {
              id,
              group: groupOf(owner.namespace),
              kind: owner.kind,
              label: owner.name,
              sub: source.vendor,
              tone: source.warning ? "warn" : "mute",
              rank: 0,
            },
            page: owner.to,
            peek: null,
          });
        const edge = `${id}>delivers>${target}`;
        edges.set(edge, {
          id: edge,
          from: id,
          to: target,
          tone: "ok",
          label: t("topology", "verbDelivers"),
        });
      }
    }
    // How many routes each edge stands for: one source may route several
    // hosts and paths into one Service.
    const routed = new Map<string, number>();
    for (const service of openServices) {
      const found = routes.of.get(`${service.namespace}/${service.name}`);
      const target = nodeId({ kind: "Service", ...service });
      for (const route of found ?? []) {
        const { source } = route;
        const id = nodeId({
          group: groupOfCrd(source.crd),
          kind: source.kind,
          namespace: source.namespace,
          name: source.name,
        });
        if (!drawn.has(id))
          drawn.set(id, {
            node: {
              id,
              group: groupOf(source.namespace),
              kind: source.kind,
              crd: source.crd ?? null,
              label: source.name,
              tone: "mute",
              rank: 1,
            },
            page: route.to ?? null,
            peek: source.crd ? { ...source, crd: source.crd } : null,
          });
        const edge = `${id}>routes>${target}`;
        const words = `${t("topology", "verbRoutes")} ${route.host}${route.path}`;
        const held = edges.get(edge);
        const more = routed.get(edge) ?? 0;
        routed.set(edge, more + 1);
        edges.set(edge, {
          id: edge,
          from: id,
          to: target,
          tone: "ok",
          label: held?.label ?? words,
          sub:
            more > 0 ? t("topology", "moreRelations", { n: more }) : undefined,
        });
      }
    }
    const unread = [
      deliveries.error &&
        t("topology", "deliveryUnread", {
          said: errorToShow(deliveries.error),
        }),
      routes.error &&
        t("topology", "routesUnread", { said: errorToShow(routes.error) }),
    ].filter((line): line is string => Boolean(line));
    return { nodes: [...drawn.values()], edges: [...edges.values()], unread };
  }
}
