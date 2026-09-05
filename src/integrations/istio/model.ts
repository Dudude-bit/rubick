/**
 * What this mesh routes, pivoted by host — the same question, one more link.
 *
 * Gateway → VirtualService → DestinationRule → Service → pods is the same
 * **chain in fixed order** Traefik's page draws, with more links in it, and
 * the same drawing serves it. What is genuinely Istio's is that the chain is
 * assembled from three objects that reference each other *by string*: a
 * VirtualService names gateways by name, a destination by hostname, and a
 * subset by a label nothing validates. Every one of those references can
 * point at nothing, and the API server accepts it without complaint.
 *
 * That is where the findings come from: a VirtualService naming a host no
 * Gateway serves is correct YAML that receives no traffic, and a route to a
 * subset no DestinationRule defines is a 503 that no object in the cluster
 * reports.
 *
 * Nothing here needs the mesh rather than its configuration — no Envoy config
 * dumps, no telemetry, no "is this route actually receiving requests".
 * Everything on this page is stated by the objects themselves, which is what
 * keeps it a tier-two page with nothing to configure.
 */

import type { T } from "@/i18n/useT";
import type {
  ChainStop,
  CustomResourceInfo,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";
import {
  backingOf as backingOfBackend,
  SEVERITY_RANK as RANK,
  worstOf,
  type Backing,
} from "../ingress";
import { readMatches, type MatchReading } from "./match";

export type { Backing } from "../ingress";

/** The reserved gateway name meaning "traffic already inside the mesh". */
export const MESH = "mesh";

export interface IstioSources {
  gateways: CustomResourceInfo[];
  virtualServices: CustomResourceInfo[];
  destinationRules: CustomResourceInfo[];
  services: ServiceInfo[];
  published: ServicePublished[];
  backingKnown?: boolean;
}

/** One `route[]` entry: where a share of the requests goes. */
export interface Destination {
  /** The hostname as written, which is what the object actually says. */
  host: string;
  /** Resolved to a Service, where the name is one this cluster could have. */
  service: { name: string; namespace: string } | null;
  /** True where the host is plainly outside the cluster — nothing is claimed. */
  external: boolean;
  subset: string | null;
  port: string | null;
  weight: number | null;
}

export interface IstioRoute {
  key: string;
  source: { kind: "VirtualService"; name: string; namespace: string };
  /** The rule's own name, where it has one. */
  name: string | null;
  /** `http`, `tls` or `tcp` — the three lists a VirtualService may carry. */
  protocol: "http" | "tls" | "tcp";
  /** The alternatives a request may satisfy. Empty means every request. */
  matches: MatchReading[];
  destinations: Destination[];
  /** The sum of the weights, where every destination states one. */
  weightSum: number | null;
}

export interface ServingGateway {
  /** As named in `spec.gateways`, which may be `ns/name`. */
  named: string;
  gateway: CustomResourceInfo | null;
  /** Whether one of its servers actually covers this host. */
  serves: boolean;
  ports: string[];
}

export type Finding =
  /** The route resolves and there is nothing behind it. */
  | { kind: "stop"; severity: "err"; route: IstioRoute; stop: ChainStop }
  /** Named gateways, and none of them serves this host. */
  | {
      kind: "noGateway";
      severity: "err";
      host: string;
      gateways: ServingGateway[];
    }
  /** A route to a subset no DestinationRule defines. */
  | {
      kind: "noSubset";
      severity: "err";
      route: IstioRoute;
      destination: Destination;
      /** The subsets that *are* defined, so the reader sees the typo. */
      defined: string[];
      /** Whether any DestinationRule names this host at all. */
      anyRule: boolean;
    }
  /** Weights that do not add up to what Istio divides by. */
  | { kind: "weights"; severity: "warn"; route: IstioRoute; sum: number };

export interface IstioHostGroup {
  host: string;
  routes: IstioRoute[];
  gateways: ServingGateway[];
  /** True where the VirtualService is for in-mesh traffic only. */
  meshOnly: boolean;
  findings: Finding[];
  chainFor: IstioRoute;
  worst: "err" | "warn" | null;
}

// --- resolving the strings ----------------------------------------------

/**
 * A destination host, resolved to a Service where it can honestly be.
 *
 * Istio takes a short name, a `name.namespace` and a full
 * `name.namespace.svc.cluster.local`, and it also takes hostnames that are
 * not in this cluster at all — a `ServiceEntry` host, an external API. The
 * last case is why this refuses rather than guessing: reporting
 * `api.stripe.com` as a missing Service would be the page inventing an
 * outage out of a working configuration.
 */
export function resolveHost(
  host: string,
  namespace: string,
  services: ServiceInfo[]
): Pick<Destination, "service" | "external"> {
  if (host.includes("*")) return { service: null, external: true };

  const labels = host.split(".");
  if (labels.length === 1) {
    return { service: { name: host, namespace }, external: false };
  }

  const cluster = host.endsWith(".svc.cluster.local");
  if (cluster) {
    return {
      service: { name: labels[0], namespace: labels[1] ?? namespace },
      external: false,
    };
  }

  // `name.namespace` is only that if the second label really is a namespace
  // this cluster has something in. Anything else is a hostname.
  const known = services.some(
    (service) => service.namespace === labels[1] && service.name === labels[0]
  );
  if (labels.length === 2 && known) {
    return {
      service: { name: labels[0], namespace: labels[1] },
      external: false,
    };
  }
  return { service: null, external: true };
}

interface RouteSpec {
  name?: string;
  match?: unknown;
  route?: Array<{
    destination?: {
      host?: string;
      subset?: string;
      port?: { number?: number };
    };
    weight?: number;
  }>;
}

function routesOf(
  object: CustomResourceInfo,
  services: ServiceInfo[],
  t: T
): IstioRoute[] {
  const spec = (object.spec ?? {}) as Record<string, unknown>;
  const namespace = object.namespace ?? "";

  const fromList = (
    protocol: IstioRoute["protocol"],
    rules: unknown
  ): IstioRoute[] => {
    if (!Array.isArray(rules)) return [];
    return rules.map((rule, index) => {
      const entry = (rule ?? {}) as RouteSpec;
      const destinations: Destination[] = (entry.route ?? []).map((leg) => {
        const host = leg.destination?.host ?? "";
        return {
          host,
          ...resolveHost(host, namespace, services),
          subset: leg.destination?.subset ?? null,
          port:
            leg.destination?.port?.number === undefined
              ? null
              : String(leg.destination.port.number),
          weight: typeof leg.weight === "number" ? leg.weight : null,
        };
      });

      const weights = destinations.filter(
        (destination) => destination.weight !== null
      );
      return {
        key: `${namespace}/${object.name}/${protocol}/${index}`,
        source: {
          kind: "VirtualService" as const,
          name: object.name,
          namespace,
        },
        name: entry.name ?? null,
        protocol,
        matches: readMatches(entry.match, t),
        destinations,
        weightSum:
          weights.length > 0 && weights.length === destinations.length
            ? weights.reduce((sum, leg) => sum + (leg.weight ?? 0), 0)
            : null,
      };
    });
  };

  return [
    ...fromList("http", spec.http),
    ...fromList("tls", spec.tls),
    ...fromList("tcp", spec.tcp),
  ];
}

// --- gateways -----------------------------------------------------------

interface GatewaySpec {
  servers?: Array<{
    hosts?: string[];
    port?: { number?: number; protocol?: string; name?: string };
  }>;
}

/**
 * Whether a Gateway server's host pattern covers this hostname.
 *
 * Istio's own three shapes: an exact name, `*`, and `*.suffix`. A server
 * host may also be namespace-qualified as `ns/host`, which is about *which
 * VirtualServices may bind*, not about the hostname — so the namespace half
 * is dropped before comparing.
 */
export function gatewayCovers(pattern: string, host: string): boolean {
  const bare = pattern.includes("/") ? pattern.split("/", 2)[1] : pattern;
  if (bare === "*") return true;
  if (bare === host) return true;
  if (bare.startsWith("*.")) return host.endsWith(bare.slice(1));
  return false;
}

/** The Gateways a VirtualService names, and whether each serves this host. */
export function gatewaysFor(
  named: string[],
  host: string,
  namespace: string,
  gateways: CustomResourceInfo[]
): ServingGateway[] {
  return named
    .filter((name) => name !== MESH)
    .map((name) => {
      const [wantedNamespace, wantedName] = name.includes("/")
        ? name.split("/", 2)
        : [namespace, name];
      const gateway =
        gateways.find(
          (candidate) =>
            candidate.name === wantedName &&
            (candidate.namespace ?? "") === wantedNamespace
        ) ?? null;

      const servers = ((gateway?.spec ?? {}) as GatewaySpec).servers ?? [];
      const matching = servers.filter((server) =>
        (server.hosts ?? []).some((pattern) => gatewayCovers(pattern, host))
      );

      return {
        named: name,
        gateway,
        serves: matching.length > 0,
        ports: matching.map(
          (server) =>
            `${server.port?.protocol ?? "?"}:${server.port?.number ?? "?"}`
        ),
      };
    });
}

// --- subsets ------------------------------------------------------------

interface DestinationRuleSpec {
  host?: string;
  subsets?: Array<{ name?: string }>;
}

/**
 * The subsets defined for a destination host, and whether any rule names it.
 *
 * Matched on the host string as written *and* on the resolved Service, so a
 * DestinationRule for `log-demo` covers a VirtualService routing to
 * `log-demo.k8s-gui-test.svc.cluster.local`. Istio resolves both to the same
 * service; a page that compared the strings would report a working mesh as
 * broken.
 */
export function subsetsFor(
  destination: Destination,
  namespace: string,
  rules: CustomResourceInfo[],
  services: ServiceInfo[]
): { defined: string[]; anyRule: boolean } {
  const matching = rules.filter((rule) => {
    const host = ((rule.spec ?? {}) as DestinationRuleSpec).host;
    if (!host) return false;
    if (host === destination.host) return true;
    const resolved = resolveHost(host, rule.namespace ?? namespace, services);
    return (
      resolved.service !== null &&
      destination.service !== null &&
      resolved.service.name === destination.service.name &&
      resolved.service.namespace === destination.service.namespace
    );
  });

  const defined = matching.flatMap((rule) =>
    (((rule.spec ?? {}) as DestinationRuleSpec).subsets ?? []).flatMap(
      (subset) => (subset.name ? [subset.name] : [])
    )
  );
  return { defined: [...new Set(defined)], anyRule: matching.length > 0 };
}

// --- what is behind a route ---------------------------------------------

export function backingOf(
  destination: Destination,
  from: IstioRoute["source"],
  sources: Pick<IstioSources, "services" | "published" | "backingKnown">
): Backing {
  // Nothing is claimed about a host outside the cluster: it has no
  // endpoints here by design, and the app cannot see inside it.
  return backingOfBackend(
    destination.external ? null : destination.service,
    from,
    sources
  );
}

// --- the hosts ----------------------------------------------------------

const URGENCY: Record<Finding["kind"], number> = {
  stop: 4,
  noSubset: 3,
  noGateway: 2,
  weights: 1,
};

function urgencyOf(findings: Finding[]): number {
  return findings.reduce(
    (worst, finding) =>
      Math.max(worst, RANK[finding.severity] * 10 + URGENCY[finding.kind]),
    0
  );
}

/**
 * What Istio divides a rule's weights by.
 *
 * A hundred, always. Istio's own validation requires the weights on a route
 * to add to it, and a set that does not is a configuration the mesh will
 * either reject or serve in a proportion nobody wrote down.
 */
const WEIGHT_TOTAL = 100;

/**
 * The page: one group per host, ordered by trouble.
 *
 * A VirtualService may declare several hosts and each gets its own group,
 * because "what serves this hostname" is the question and one object
 * answering for four of them is four answers.
 */
export function hostGroups(sources: IstioSources, t: T): IstioHostGroup[] {
  const byHost = new Map<
    string,
    { routes: IstioRoute[]; named: string[]; namespace: string }
  >();

  for (const object of sources.virtualServices) {
    const spec = (object.spec ?? {}) as {
      hosts?: string[];
      gateways?: string[];
    };
    const namespace = object.namespace ?? "";
    const routes = routesOf(object, sources.services, t);
    // No `gateways` at all means the mesh gateway, which is Istio's default
    // and is in-mesh traffic rather than a missing reference.
    const named = spec.gateways ?? [MESH];

    for (const host of spec.hosts ?? []) {
      const existing = byHost.get(host);
      byHost.set(host, {
        routes: [...(existing?.routes ?? []), ...routes],
        named: [...new Set([...(existing?.named ?? []), ...named])],
        namespace: existing?.namespace ?? namespace,
      });
    }
  }

  const groups: IstioHostGroup[] = [...byHost.entries()].map(
    ([host, { routes, named, namespace }]) => {
      const gateways = gatewaysFor(named, host, namespace, sources.gateways);
      const meshOnly = named.every((name) => name === MESH);

      const findings: Finding[] = [];

      // A VirtualService bound to a Gateway that does not cover its host
      // receives nothing at the edge, and no object in the cluster says so.
      if (!meshOnly && gateways.length > 0 && !gateways.some((g) => g.serves)) {
        findings.push({ kind: "noGateway", severity: "err", host, gateways });
      }

      const seenStops = new Set<string>();
      for (const route of routes) {
        for (const destination of route.destinations) {
          const backing = backingOf(destination, route.source, sources);
          if (backing.stop) {
            const stopKey = `${backing.stop.reason}/${backing.stop.service.namespace}/${backing.stop.service.name}`;
            if (!seenStops.has(stopKey)) {
              seenStops.add(stopKey);
              findings.push({
                kind: "stop",
                severity: "err",
                route,
                stop: backing.stop,
              });
            }
          }

          if (destination.subset) {
            const { defined, anyRule } = subsetsFor(
              destination,
              namespace,
              sources.destinationRules,
              sources.services
            );
            if (!defined.includes(destination.subset)) {
              findings.push({
                kind: "noSubset",
                severity: "err",
                route,
                destination,
                defined,
                anyRule,
              });
            }
          }
        }

        if (route.weightSum !== null && route.weightSum !== WEIGHT_TOTAL) {
          findings.push({
            kind: "weights",
            severity: "warn",
            route,
            sum: route.weightSum,
          });
        }
      }

      return {
        host,
        routes,
        gateways,
        meshOnly,
        findings,
        // The rule the chain is drawn for: the one that is broken, or the
        // one with the most in it. A default route straight to one Service
        // is the one the rows above already say in full.
        chainFor:
          findings.find(
            (finding) => finding.kind === "stop" || finding.kind === "noSubset"
          )?.route ??
          [...routes].sort(
            (a, b) => b.destinations.length - a.destinations.length
          )[0],
        worst: worstOf(findings),
      };
    }
  );

  return groups.filter((group) => group.routes.length > 0).sort(compareGroups);
}

function compareGroups(a: IstioHostGroup, b: IstioHostGroup): number {
  const rank = (group: IstioHostGroup) => urgencyOf(group.findings);
  if (rank(a) !== rank(b)) return rank(b) - rank(a);
  if (a.findings.length !== b.findings.length) {
    return b.findings.length - a.findings.length;
  }
  return a.host.localeCompare(b.host);
}
