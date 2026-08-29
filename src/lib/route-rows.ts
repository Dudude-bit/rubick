/**
 * The routes list as the trace's index.
 *
 * Every row is `routeTraces()` reduced to one line: what the route serves,
 * and — only when broken — the step it stops at, in the same words the
 * detail page expands. The list and the trace are one vocabulary at two
 * zooms; this module owns the zoom-out and nothing else.
 */

import type {
  GatewayInfo,
  ParentRefInfo,
  RouteInfo,
  RouteMatchInfo,
} from "@/generated/types";
import {
  findGateway,
  gatewayProgrammed,
  HOSTLESS_PROTO,
  redirectOnly,
  routeTraces,
  selfAnswered,
  type RouteTrace,
  type TraceSources,
  type TraceStep,
  type TraceStepId,
} from "@/lib/route-trace";
import type { T } from "@/i18n/useT";

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
  /** Where it stops, as a step id — the word is the renderer's business.
   *  A table of words here meant one of them ("references") could never be
   *  matched by the switch that translates them. */
  stop: { at: TraceStepId | "route"; short: string } | null;
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

/**
 * The routes row's one-pixel opinion for the sidebar: err while anything
 * is dead, warn while a verdict is stale or a host contested — and
 * nothing at all before the verdicts are known, because a guess in the
 * rail is worse than silence.
 */
export function boardMark(board: RoutesBoard): "warn" | "err" | undefined {
  if (!board.verdictsKnown) return undefined;
  if (board.notServing.length > 0) return "err";
  if (board.serving.some((row) => row.stale != null || row.contested != null)) {
    return "warn";
  }
  return undefined;
}

/**
 * The gateways row's: err for the pulse problems — each one means
 * everything through that gateway is dead — and warn for a controller
 * that has not spoken a Programmed verdict at all.
 */
export function gatewaysMark(
  gateways: GatewayInfo[],
  pulse: GatewayPulse[],
  topologyKnown: boolean
): "warn" | "err" | undefined {
  if (pulse.length > 0) return "err";
  if (!topologyKnown) return undefined;
  if (gateways.some((gateway) => !gatewayProgrammed(gateway))) return "warn";
  return undefined;
}

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
function pulseOf(sources: TraceSources, t: T): GatewayPulse[] {
  if (!sources.topologyKnown) return [];
  const pulse: GatewayPulse[] = [];
  for (const gateway of sources.gateways) {
    const at = { gateway: gateway.name, namespace: gateway.namespace };
    const cls = sources.classes.find((c) => c.name === gateway.className);
    if (!cls) {
      pulse.push({
        ...at,
        say: t("empty", "gwRowClassMissing", { name: gateway.className }),
      });
      continue;
    }
    if (cls.accepted !== true) {
      pulse.push({
        ...at,
        say: t("empty", "gwRowClassUnclaimed", { name: gateway.className }),
      });
      continue;
    }
    const programmed = gatewayProgrammed(gateway);
    if (programmed?.status === "False") {
      pulse.push({ ...at, say: t("empty", "gwRowNotProgrammed") });
      continue;
    }
    if (gateway.addresses.length === 0) {
      pulse.push({
        ...at,
        say: t("empty", "gwRowNoAddress"),
      });
    }
  }
  return pulse;
}

/**
 * Whether two routes can both answer one request on a hostname they share.
 *
 * Sharing a hostname is not a conflict: the spec merges HTTPRoutes on one
 * hostname and resolves precedence per match, which is exactly how a team
 * splits `shop.example.com` into `/cart` and `/checkout` across two routes.
 * Calling that a contest put a warn badge on every healthy cluster that does
 * it, and a standing mark in the sidebar.
 *
 * So the question is whether their matches can both apply. A route that
 * declares no match at all matches everything, and two paths that provably
 * cannot collide are two routes that never meet.
 */
function matchesOverlap(a: RouteMatchInfo, b: RouteMatchInfo): boolean {
  // Different methods can never be the same request.
  if (a.method && b.method && a.method !== b.method) return false;
  if (a.grpcService && b.grpcService && a.grpcService !== b.grpcService) {
    return false;
  }
  if (a.grpcMethod && b.grpcMethod && a.grpcMethod !== b.grpcMethod) {
    return false;
  }

  // An absent path is "/" as a prefix: it reaches everything.
  const reach = (m: RouteMatchInfo) => ({
    path: m.path ?? "/",
    exact: m.pathType === "Exact",
  });
  const one = reach(a);
  const two = reach(b);
  if (one.exact && two.exact) return one.path === two.path;
  if (one.exact) return one.path.startsWith(two.path);
  if (two.exact) return two.path.startsWith(one.path);
  return one.path.startsWith(two.path) || two.path.startsWith(one.path);
}

function routesMeet(a: RouteInfo, b: RouteInfo): boolean {
  const of = (route: RouteInfo) => route.rules.flatMap((rule) => rule.matches);
  const mine = of(a);
  const theirs = of(b);
  // No matches means no narrowing: the route takes the whole hostname.
  if (mine.length === 0 || theirs.length === 0) return true;
  return mine.some((one) => theirs.some((two) => matchesOverlap(one, two)));
}

export function routesBoard(
  routes: RouteInfo[],
  sources: TraceSources,
  t: T
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
      // Only the rivals this route can actually meet on a request.
      const meeting = rivals.filter(
        (rival) =>
          identity(rival) === identity(route) || routesMeet(route, rival)
      );
      const winner = [...meeting].sort(
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
            short: t("empty", "gwRowNoParents"),
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
        tail: t("empty", "gwRowMesh", {
          parent: `${parent.kind} ${parent.name}`,
        }),
        via: parent.name,
        viaRef: exists ? ref : null,
        viaGhost: settled && !exists ? ref : null,
        contested: null,
        serving: true,
      });
      continue;
    }

    const traces = routeTraces(route, sources, t);
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
        ? { at: broken.id, short: broken.short ?? broken.say }
        : null,
      tail: redirectOnly(route)
        ? t("empty", "gwRowRedirects")
        : selfAnswered(route)
          ? t("empty", "gwRowFilterNamed")
          : null,
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
    pulse: pulseOf(sources, t),
  };
}
