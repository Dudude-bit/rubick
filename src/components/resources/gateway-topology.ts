/**
 * The routing layer's shape, first mile to last:
 * IP → Gateways → Kinds → Routes → Backends → Workloads.
 *
 * Nothing here is inferred. A Gateway column node is a Gateway that exists
 * — or one a parentRef names and the API server does not have, drawn as
 * the missing thing. An edge is one object naming another; a tone is a
 * verdict somebody wrote (`Programmed`, `Accepted`) or what the Service's
 * own slices publish. A mesh parentRef (`kind: Service`) draws no Gateway
 * node: the route simply has no entry point on this map, which is the
 * truth of it.
 *
 * The outer layers exist only where they say something: the IP column when
 * a gateway published an address, the kind funnel when the routes span
 * more than one kind, the workloads when the pod lists have answered. A
 * kind node is per (gateway, kind), never shared — one funnel for two
 * gateways would merge their flows and lose which route enters where.
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
import { KIND_TEXT } from "@/lib/route-kind-tone";
import type { GatewayInfo, PodInfo, RouteInfo } from "@/generated/types";
import { gatewayProgrammed } from "@/lib/route-trace";

/** What the last column is built from — handed over only once both lists
 *  have answered, because a workload column guessed from half the pods
 *  would draw missing workloads that are merely unread. */
export interface WorkloadSources {
  pods: PodInfo[];
  deployments: Array<{ name: string; namespace: string }>;
}

/** The controller that owns a pod, with the ReplicaSet hop collapsed into
 *  its Deployment — but only when that Deployment actually exists, never
 *  by trusting the name's shape alone. */
function ownerOf(
  pod: PodInfo,
  deployments: Map<string, Set<string>>
): { kind: string; name: string } | null {
  const owner =
    pod.ownerReferences.find((ref) => ref.controller) ?? pod.ownerReferences[0];
  if (!owner) return null;
  if (owner.kind === "ReplicaSet") {
    const cut = owner.name.lastIndexOf("-");
    const candidate = cut > 0 ? owner.name.slice(0, cut) : null;
    if (candidate && deployments.get(pod.namespace)?.has(candidate)) {
      return { kind: "Deployment", name: candidate };
    }
  }
  return { kind: owner.kind, name: owner.name };
}

function gatewayTone(gateway: GatewayInfo): { tone: MapTone; sub?: string } {
  const programmed = gatewayProgrammed(gateway);
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
  /**
   * `undefined` while the list has not been read — the same shape `backing`
   * uses, and for the same reason. A route names a parent this map has to
   * draw either way; whether that parent is *missing* is a claim only a list
   * that was actually read can make.
   */
  gateways: GatewayInfo[] | undefined,
  routes: RouteInfo[],
  backing: BackingSources | undefined,
  t: T,
  workloads?: WorkloadSources
): RoutingMapData {
  const gatewaysKnown = gateways !== undefined;
  const drawn = gateways ?? [];
  const gatewayNodes = new Map<string, MapNode>();
  const kindNodes = new Map<string, MapNode>();
  // The worst verdict flowing into each funnel node, for its gateway edge.
  const kindEdgeTone = new Map<string, { gatewayId: string; tone: MapTone }>();
  const kindRouteCount = new Map<string, number>();
  const routeNodes: MapNode[] = [];
  const backendNodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const linked = new Set<string>();
  // One funnel node per kind is only honest while it cannot merge flows.
  const drawKinds = new Set(routes.map((route) => route.kind)).size >= 2;

  const link = (from: string, to: string, tone: MapTone) => {
    const key = `${from}->${to}`;
    if (linked.has(key)) return;
    linked.add(key);
    edges.push({ from, to, tone });
  };

  for (const gateway of drawn) {
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
      tag: {
        text: route.kind,
        tone: "mute",
        className: KIND_TEXT[route.kind],
      },
    });

    for (const parent of route.parentRefs) {
      // GAMMA/mesh and any other non-Gateway parent: no entry point on this
      // map, and above all no "missing Gateway" invented for it.
      if (parent.kind !== "Gateway") continue;
      const ns = parent.namespace ?? route.namespace;
      const gatewayId = `gw/${ns}/${parent.name}`;
      if (!gatewayNodes.has(gatewayId)) {
        // Only a list that was read can say the gateway is not in it. Unread,
        // the node still gets drawn — the route does name it — but muted and
        // unlabelled, the way an unread backend is.
        gatewayNodes.set(gatewayId, {
          id: gatewayId,
          label: parent.name,
          sub: ns,
          tone: gatewaysKnown ? "err" : "mute",
          tag: gatewaysKnown
            ? { text: t("columns", "missingTag"), tone: "err" }
            : undefined,
        });
      }
      const verdict: MapTone = refusedBy(route, parent.name, ns)
        ? "err"
        : "mute";
      if (!drawKinds) {
        link(gatewayId, routeId, verdict);
      } else {
        const kindId = `kind/${gatewayId}/${route.kind}`;
        if (!kindNodes.has(kindId)) {
          kindNodes.set(kindId, {
            id: kindId,
            label: route.kind,
            labelClassName: KIND_TEXT[route.kind],
            tone: "mute",
          });
          kindEdgeTone.set(kindId, { gatewayId, tone: verdict });
        } else if (verdict === "err") {
          kindEdgeTone.get(kindId)!.tone = "err";
        }
        kindRouteCount.set(kindId, (kindRouteCount.get(kindId) ?? 0) + 1);
        link(kindId, routeId, verdict);
      }
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
                ? describeStop(stop, t).title
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

  for (const [kindId, edge] of kindEdgeTone) {
    const node = kindNodes.get(kindId)!;
    node.sub = t("count", "nRoutes", { n: kindRouteCount.get(kindId) ?? 0 });
    link(edge.gatewayId, kindId, edge.tone);
  }

  // The first mile: every address a drawn gateway publishes, deduplicated —
  // two gateways behind one LB are two edges out of one node.
  const ipNodes = new Map<string, MapNode>();
  for (const gateway of drawn) {
    const gatewayId = `gw/${gateway.namespace}/${gateway.name}`;
    if (!gatewayNodes.has(gatewayId)) continue;
    for (const address of gateway.addresses) {
      const ipId = `ip/${address}`;
      if (!ipNodes.has(ipId)) {
        ipNodes.set(ipId, { id: ipId, label: address, tone: "mute" });
      }
      link(ipId, gatewayId, "mute");
    }
  }

  // The last: what actually runs behind each backend Service — its
  // published endpoints resolved to pods, the pods to their controllers.
  const workloadNodes = new Map<string, MapNode>();
  if (workloads && backing) {
    const podByKey = new Map(
      workloads.pods.map((pod) => [`${pod.namespace}/${pod.name}`, pod])
    );
    const deploymentNames = new Map<string, Set<string>>();
    for (const deployment of workloads.deployments) {
      const at = deploymentNames.get(deployment.namespace) ?? new Set();
      at.add(deployment.name);
      deploymentNames.set(deployment.namespace, at);
    }

    for (const node of backendNodes.values()) {
      if (node.object?.kind !== "Service" || node.object.namespace == null) {
        continue;
      }
      const service = node.object;
      const published = backing.published.find(
        (entry) =>
          entry.service.name === service.name &&
          entry.service.namespace === service.namespace
      );
      if (!published) continue;

      const behind = new Map<
        string,
        {
          kind: string | null;
          name: string | null;
          ready: number;
          total: number;
        }
      >();
      for (const endpoint of published.endpoints) {
        const target = endpoint.target;
        const pod =
          target?.kind === "Pod"
            ? podByKey.get(
                `${target.namespace ?? service.namespace}/${target.name}`
              )
            : undefined;
        const owner = pod ? ownerOf(pod, deploymentNames) : null;
        // Pods with no controller — and addresses whose pod the list does
        // not hold — group into one quiet node instead of vanishing.
        const key = owner
          ? `${owner.kind}/${owner.name}`
          : `bare/${service.name}`;
        const entry = behind.get(key) ?? {
          kind: owner?.kind ?? null,
          name: owner?.name ?? null,
          ready: 0,
          total: 0,
        };
        entry.total += 1;
        if (endpoint.ready) entry.ready += 1;
        behind.set(key, entry);
      }

      for (const [key, entry] of behind) {
        const wlId =
          entry.kind != null
            ? `wl/${entry.kind}/${service.namespace}/${entry.name}`
            : `wl/bare/${service.namespace}/${key}`;
        if (!workloadNodes.has(wlId)) {
          workloadNodes.set(wlId, {
            id: wlId,
            label: entry.name ?? t("count", "nBarePods", { n: entry.total }),
            sub: t("count", "ofTotalReady", {
              n: entry.ready,
              total: entry.total,
            }),
            tone: entry.ready > 0 ? "ok" : entry.total > 0 ? "err" : "mute",
            ...(entry.kind != null && entry.name != null
              ? {
                  object: {
                    kind: entry.kind,
                    name: entry.name,
                    namespace: service.namespace,
                  },
                  tag: { text: entry.kind, tone: "mute" as MapTone },
                }
              : {}),
          });
        }
        link(
          node.id,
          wlId,
          workloadNodes.get(wlId)?.tone === "err" ? "err" : "mute"
        );
      }
    }
  }

  const columns = [];
  if (ipNodes.size > 0) {
    columns.push({
      label: t("columns", "ip"),
      nodes: [...ipNodes.values()],
      width: 150,
    });
  }
  columns.push({
    label: t("columns", "gateways"),
    nodes: [...gatewayNodes.values()],
  });
  if (drawKinds) {
    columns.push({
      label: t("columns", "kinds"),
      nodes: [...kindNodes.values()],
      width: 130,
    });
  }
  const spine = columns.length;
  columns.push({ label: t("nav", "routes"), nodes: routeNodes, width: 240 });
  columns.push({
    label: t("columns", "backends"),
    nodes: [...backendNodes.values()],
  });
  if (workloadNodes.size > 0) {
    columns.push({
      label: t("nav", "workloads"),
      nodes: [...workloadNodes.values()],
      width: 200,
    });
  }

  return { columns, edges, spine };
}
