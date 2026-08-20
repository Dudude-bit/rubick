/**
 * The routing layer's shape: Gateways → routes → backends, as a
 * three-column map.
 *
 * Nothing here is inferred. A Gateway column node is a Gateway that exists
 * — or one a parentRef names and the API server does not have, drawn as
 * the missing thing. An edge is one object naming another; a tone is a
 * verdict somebody wrote (`Programmed`, `Accepted`) or what the Service's
 * own slices publish. A mesh parentRef (`kind: Service`) draws no Gateway
 * node: the route simply has no entry point on this map, which is the
 * truth of it.
 */

import {
  backingOf,
  type BackingSources,
  type RoutingMapData,
  type MapEdge,
  type MapNode,
  type MapTone,
} from "@/integrations";
import { describeStop } from "@/lib/connections";
import type { T } from "@/i18n/useT";
import type { GatewayInfo, RouteInfo } from "@/generated/types";

function gatewayTone(gateway: GatewayInfo): { tone: MapTone; sub?: string } {
  const programmed =
    gateway.conditions.find((c) => c.type === "Programmed") ??
    gateway.conditions.find((c) => c.type === "Ready");
  const sub = [gateway.className, gateway.addresses[0]]
    .filter(Boolean)
    .join(" · ");
  if (!programmed) return { tone: "mute", sub: sub || undefined };
  if (programmed.status === "True")
    return { tone: "ok", sub: sub || undefined };
  return { tone: "err", sub: programmed.reason ?? (sub || undefined) };
}

/** The Accepted verdicts this route's Gateway parents wrote. */
function routeTone(route: RouteInfo): MapTone {
  const verdicts = route.parents.flatMap((parent) =>
    parent.conditions.filter((c) => c.type === "Accepted")
  );
  if (verdicts.some((c) => c.status === "False")) return "err";
  if (verdicts.length > 0 && verdicts.every((c) => c.status === "True"))
    return "ok";
  return "mute";
}

/** Whether this parent's own status entry says the Gateway refused it. */
function refusedBy(
  route: RouteInfo,
  gatewayName: string,
  gatewayNamespace: string
): boolean {
  return route.parents.some(
    (entry) =>
      entry.parent.name === gatewayName &&
      (entry.parent.namespace ?? route.namespace) === gatewayNamespace &&
      entry.conditions.some(
        (c) => c.type === "Accepted" && c.status === "False"
      )
  );
}

export function gatewayTopology(
  gateways: GatewayInfo[],
  routes: RouteInfo[],
  backing: BackingSources | undefined,
  t: T
): RoutingMapData {
  const gatewayNodes = new Map<string, MapNode>();
  const routeNodes: MapNode[] = [];
  const backendNodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const linked = new Set<string>();

  const link = (from: string, to: string, tone: MapTone) => {
    const key = `${from}->${to}`;
    if (linked.has(key)) return;
    linked.add(key);
    edges.push({ from, to, tone });
  };

  for (const gateway of gateways) {
    const { tone, sub } = gatewayTone(gateway);
    gatewayNodes.set(`gw/${gateway.namespace}/${gateway.name}`, {
      id: `gw/${gateway.namespace}/${gateway.name}`,
      label: gateway.name,
      sub,
      tone,
      object: {
        kind: "Gateway",
        name: gateway.name,
        namespace: gateway.namespace,
      },
    });
  }

  for (const route of routes) {
    const routeId = `route/${route.kind}/${route.namespace}/${route.name}`;
    routeNodes.push({
      id: routeId,
      label: route.name,
      sub: route.hostnames.length > 0 ? route.hostnames.join(", ") : undefined,
      tone: routeTone(route),
      object: {
        kind: route.kind,
        name: route.name,
        namespace: route.namespace,
      },
      tag: { text: route.kind, tone: "mute" },
    });

    for (const parent of route.parentRefs) {
      // GAMMA/mesh and any other non-Gateway parent: no entry point on this
      // map, and above all no "missing Gateway" invented for it.
      if (parent.kind !== "Gateway") continue;
      const ns = parent.namespace ?? route.namespace;
      const gatewayId = `gw/${ns}/${parent.name}`;
      if (!gatewayNodes.has(gatewayId)) {
        gatewayNodes.set(gatewayId, {
          id: gatewayId,
          label: parent.name,
          sub: ns,
          tone: "err",
          tag: { text: t("columns", "missingTag"), tone: "err" },
        });
      }
      link(
        gatewayId,
        routeId,
        refusedBy(route, parent.name, ns) ? "err" : "mute"
      );
    }

    for (const rule of route.rules) {
      for (const backend of rule.backendRefs) {
        const ns = backend.namespace ?? route.namespace;
        const backendId = `backend/${backend.kind}/${ns}/${backend.name}`;
        if (!backendNodes.has(backendId)) {
          if (backend.kind !== "Service") {
            backendNodes.set(backendId, {
              id: backendId,
              label: backend.name,
              sub: ns,
              tone: "mute",
              tag: { text: backend.kind, tone: "mute" },
            });
          } else {
            const state = backing
              ? backingOf(
                  { name: backend.name, namespace: ns },
                  {
                    kind: route.kind,
                    name: route.name,
                    namespace: route.namespace,
                  },
                  backing
                )
              : null;
            const stop = state?.known ? state.stop : null;
            backendNodes.set(backendId, {
              id: backendId,
              label: backend.name,
              sub: stop
                ? describeStop(stop).title
                : state?.known
                  ? state.service?.type === "ExternalName"
                    ? t("empty", "resolvesElsewhere")
                    : t("count", "nReady", { n: state.ready }) +
                      (state.draining > 0
                        ? `, ${t("count", "nDraining", { n: state.draining })}`
                        : "")
                  : undefined,
              tone: stop ? "err" : state?.known ? "ok" : "mute",
              object: { kind: "Service", name: backend.name, namespace: ns },
            });
          }
        }
        link(
          routeId,
          backendId,
          backendNodes.get(backendId)?.tone === "err" ? "err" : "mute"
        );
      }
    }
  }

  return {
    columns: [
      { label: "Gateways", nodes: [...gatewayNodes.values()] },
      { label: t("nav", "routes"), nodes: routeNodes, width: 240 },
      { label: t("columns", "backends"), nodes: [...backendNodes.values()] },
    ],
    edges,
  };
}
