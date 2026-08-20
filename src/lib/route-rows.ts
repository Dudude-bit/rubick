/**
 * The routes list as the trace's index.
 *
 * Every row is `routeTraces()` reduced to one line: what the route serves,
 * and — only when broken — the step it stops at, in the same words the
 * detail page expands. The list and the trace are one vocabulary at two
 * zooms; this module owns the zoom-out and nothing else.
 */

import type { ParentRefInfo, RouteInfo } from "@/generated/types";
import {
  findGateway,
  gatewayProgrammed,
  HOSTLESS_PROTO,
  redirectOnly,
  routeTraces,
  type RouteTrace,
  type TraceSources,
  type TraceStep,
  type TraceStepId,
} from "@/lib/route-trace";

export interface RouteRow {
  kind: string;
  name: string;
  namespace: string;
  /** What the route serves: its first hostname, or `:port PROTO`. */
  serves: string;
  /** What a click puts on the clipboard: the hostname, or the dialable
   *  `address:port` for a hostless route. Null where nothing honest exists. */
  servesCopy: string | null;
  /** How many further hostnames hide behind {@link serves}. */
  more: number;
  /** The break, compressed: which link and why — null on a serving row. */
  stop: { at: string; short: string } | null;
  /** A quiet configuration note on a serving row (redirect-only, mesh). */
  tail: string | null;
  stale: { observed: number; current: number } | null;
  /** The way in: gateway and listener, or the mesh parent. */
  via: string;
  /** The way in as an object — set only where it exists, so the row can
   *  offer its peek without ever linking to a 404. */
  viaRef: { kind: string; name: string; namespace: string } | null;
  /** The way in named as *known missing* — the sources were read and the
   *  object is not there. Null while they are still loading: absence is
   *  only a fact once the list that would hold it has answered. */
  viaGhost: { kind: string; name: string; namespace: string } | null;
  /** Another route on the same gateway claims the same hostname — per the
   *  spec the older route wins, so this names the winner. Exact matches
   *  only; wildcard overlap is the controller's verdict to give. */
  contested: { by: string } | null;
  createdAt: string | null;
  serving: boolean;
}

export interface GatewayPulse {
  gateway: string;
  namespace: string;
  say: string;
}

export interface RoutesBoard {
  /** False while gateways, classes or backing are still being read —
   *  verdicts drawn before then would be guesses. */
  verdictsKnown: boolean;
  notServing: RouteRow[];
  serving: RouteRow[];
  mesh: RouteRow[];
  /** Gateway-level breaks the route rows cannot carry. */
  pulse: GatewayPulse[];
}

/** The step ids in the reader's words — "refs" is jargon, "references" is not. */
const STEP_LABEL: Record<TraceStepId, string> = {
  class: "class",
  gateway: "gateway",
  listener: "listener",
  namespace: "namespace",
  refs: "references",
  backend: "backend",
  endpoints: "endpoints",
  reachable: "reachable",
};

function servesOf(
  route: RouteInfo,
  trace: RouteTrace | undefined
): { serves: string; servesCopy: string | null } {
  if (route.hostnames.length > 0) {
    return { serves: route.hostnames[0], servesCopy: route.hostnames[0] };
  }
  if (trace?.probe.port != null) {
    const proto = HOSTLESS_PROTO[route.kind];
    return {
      serves: `:${trace.probe.port}${proto ? ` ${proto}` : ""}`,
      // The dialable pair, where the gateway published an address — the
      // label alone dials nothing.
      servesCopy:
        trace.probe.address != null
          ? `${trace.probe.address}:${trace.probe.port}`
          : null,
    };
  }
  return { serves: route.name, servesCopy: null };
}

function viaOf(parents: ParentRefInfo[]): string {
  if (parents.length === 0) return "—";
  const first = parents[0];
  const section = first.sectionName ? ` :${first.sectionName}` : "";
  const rest = parents.length > 1 ? ` +${parents.length - 1}` : "";
  return `${first.name}${section}${rest}`;
}

function firstBroken(trace: RouteTrace): TraceStep | undefined {
  return trace.stopStep == null ? undefined : trace.steps[trace.stopStep - 1];
}

function staleOf(
  traces: RouteTrace[]
): { observed: number; current: number } | null {
  for (const trace of traces) {
    for (const step of trace.steps) {
      if (step.freshness) return step.freshness;
    }
  }
  return null;
}

/** Class and address problems on the gateway itself — upstream of every
 *  route through it, and invisible on any single route's row. */
function pulseOf(sources: TraceSources): GatewayPulse[] {
  if (!sources.topologyKnown) return [];
  const pulse: GatewayPulse[] = [];
  for (const gateway of sources.gateways) {
    const at = { gateway: gateway.name, namespace: gateway.namespace };
    const cls = sources.classes.find((c) => c.name === gateway.className);
    if (!cls) {
      pulse.push({
        ...at,
        say: `names class ${gateway.className}, which does not exist — anything attached to it is dead`,
      });
      continue;
    }
    if (cls.accepted !== true) {
      pulse.push({
        ...at,
        say: `nothing claims class ${gateway.className} — anything attached to it is dead`,
      });
      continue;
    }
    const programmed = gatewayProgrammed(gateway);
    if (programmed?.status === "False") {
      pulse.push({ ...at, say: "is not programmed by its controller" });
      continue;
    }
    if (gateway.addresses.length === 0) {
      pulse.push({
        ...at,
        say: "has no address yet — traffic has nowhere to arrive",
      });
    }
  }
  return pulse;
}

export function routesBoard(
  routes: RouteInfo[],
  sources: TraceSources
): RoutesBoard {
  const notServing: Array<{ row: RouteRow; depth: number }> = [];
  const serving: RouteRow[] = [];
  const mesh: RouteRow[] = [];

  // Who claims which host on which gateway. The spec resolves the tie —
  // oldest creationTimestamp wins, then alphabetical — so the loser's row
  // can name the exact route that is actually serving its hostname.
  const claims = new Map<string, RouteInfo[]>();
  for (const route of routes) {
    const first = route.parentRefs.find((parent) => parent.kind === "Gateway");
    if (!first) continue;
    for (const host of route.hostnames) {
      const at = `${first.namespace ?? route.namespace}/${first.name}/${host}`;
      claims.set(at, [...(claims.get(at) ?? []), route]);
    }
  }
  const contestedBy = (route: RouteInfo): { by: string } | null => {
    const first = route.parentRefs.find((parent) => parent.kind === "Gateway");
    if (!first) return null;
    for (const host of route.hostnames) {
      const rivals =
        claims.get(
          `${first.namespace ?? route.namespace}/${first.name}/${host}`
        ) ?? [];
      if (rivals.length < 2) continue;
      const identity = (r: RouteInfo) => `${r.kind}/${r.namespace}/${r.name}`;
      const winner = [...rivals].sort(
        (a, b) =>
          (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
          identity(a).localeCompare(identity(b))
      )[0];
      if (identity(winner) !== identity(route)) return { by: winner.name };
    }
    return null;
  };

  for (const route of routes) {
    const gatewayParents = route.parentRefs.filter(
      (parent) => parent.kind === "Gateway"
    );
    const base = {
      kind: route.kind,
      name: route.name,
      namespace: route.namespace,
      more: Math.max(0, route.hostnames.length - 1),
      stale: null,
      tail: null,
      createdAt: route.createdAt,
    };

    if (route.parentRefs.length === 0) {
      notServing.push({
        depth: 0,
        row: {
          ...base,
          ...servesOf(route, undefined),
          stop: {
            at: "route",
            short: "no parentRefs — attaches to nothing and serves no traffic",
          },
          via: "—",
          viaRef: null,
          viaGhost: null,
          contested: null,
          serving: false,
        },
      });
      continue;
    }

    if (gatewayParents.length === 0) {
      const parent = route.parentRefs[0];
      const at = parent.namespace ?? route.namespace;
      const settled =
        parent.kind === "Service" && sources.backing.backingKnown !== false;
      const exists =
        settled &&
        sources.backing.services.some(
          (service) => service.name === parent.name && service.namespace === at
        );
      const ref = { kind: parent.kind, name: parent.name, namespace: at };
      mesh.push({
        ...base,
        ...servesOf(route, undefined),
        stop: null,
        tail: `attaches to ${parent.kind} ${parent.name} — GAMMA, not judged here`,
        via: parent.name,
        viaRef: exists ? ref : null,
        viaGhost: settled && !exists ? ref : null,
        contested: null,
        serving: true,
      });
      continue;
    }

    const traces = routeTraces(route, sources);
    const worst = traces.reduce((sofar, trace) =>
      (trace.stopStep ?? Infinity) < (sofar.stopStep ?? Infinity)
        ? trace
        : sofar
    );
    const broken = firstBroken(worst);
    const row: RouteRow = {
      ...base,
      ...servesOf(route, worst),
      stop: broken
        ? { at: STEP_LABEL[broken.id], short: broken.short ?? broken.say }
        : null,
      tail: redirectOnly(route) ? "redirects — no backends, none needed" : null,
      // The worst trace is the one whose break the row shows — its
      // staleness first, so the badge never belongs to the other gateway.
      stale: staleOf([worst, ...traces.filter((trace) => trace !== worst)]),
      via: viaOf(gatewayParents),
      ...(() => {
        const first = gatewayParents[0];
        const at = first.namespace ?? route.namespace;
        const ref = { kind: "Gateway", name: first.name, namespace: at };
        const exists = findGateway(sources.gateways, first.name, at) != null;
        return {
          viaRef: exists ? ref : null,
          viaGhost: sources.topologyKnown && !exists ? ref : null,
        };
      })(),
      contested: contestedBy(route),
      serving: broken == null,
    };
    if (broken) {
      notServing.push({ row, depth: worst.stopStep ?? Infinity });
    } else {
      serving.push(row);
    }
  }

  notServing.sort(
    (a, b) => a.depth - b.depth || a.row.serves.localeCompare(b.row.serves)
  );
  serving.sort((a, b) => a.serves.localeCompare(b.serves));
  mesh.sort((a, b) => a.name.localeCompare(b.name));

  return {
    verdictsKnown:
      sources.topologyKnown && sources.backing.backingKnown !== false,
    notServing: notServing.map((entry) => entry.row),
    serving,
    mesh,
    pulse: pulseOf(sources),
  };
}
