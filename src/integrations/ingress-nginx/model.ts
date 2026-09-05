/**
 * What this cluster's ingress-nginx serves, pivoted the way the question is
 * asked — *what serves this hostname*, *why is this URL not working*. The same
 * pivot Traefik's page uses, and the shared half lives in `../ingress`.
 *
 * nginx is Ingress-only: no CRDs, so no second object model, no rule language
 * to refuse to paraphrase, and no entry points — it listens on 80 and 443 and
 * that is not configuration this app has to go and read. The whole routing
 * table is the Ingresses whose class this controller claims.
 *
 * Its behaviour is all in annotations, which is why {@link ./annotations}
 * exists and why it refuses more than it decodes. A canary is where that
 * refusal is not enough on its own: `canary: "true"` does not mean "a route"
 * but **"a second route for a host another Ingress already serves"**, and a
 * page that listed it as its own host would draw two hosts where the cluster
 * has one, each looking like it takes all the traffic. So a canary is grouped
 * under the host it shadows and read as a share of it.
 */

import type { T } from "@/i18n/useT";
import type {
  ChainStop,
  IngressClassSummary,
  IngressInfo,
  ServiceInfo,
  ServicePublished,
  TlsCertificate,
} from "@/generated/types";
import { covers, type Expiry } from "@/lib/certificates";
import {
  backingOf as backingOfBackend,
  certificateProblems,
  claimsIngress,
  classesOf,
  SEVERITY_RANK as RANK,
  tlsSecretFor,
  worstOf,
  type Backing,
  type SecretRef,
} from "../ingress";
import { PREFIX, readAnnotations, type AnnotationReading } from "./annotations";

export type { Backing } from "../ingress";

/** What ingress-nginx writes into an IngressClass's `spec.controller`. */
export const CONTROLLER = "k8s.io/ingress-nginx";

/**
 * A canary Ingress, read as what nginx does with it.
 *
 * The order of the fields is the order nginx checks them: a header rule
 * decides on its own and the weight is never reached, so a page that showed
 * only the weight would describe a split that does not happen.
 */
export interface Canary {
  byHeader: string | null;
  byHeaderValue: string | null;
  byCookie: string | null;
  weight: number | null;
  /** `canary-weight-total`, which defaults to 100 and is usually left there. */
  weightTotal: number;
}

export interface NginxRoute {
  key: string;
  source: { kind: "Ingress"; name: string; namespace: string };
  /** `null` is a rule with no host — a catch-all, drawn last. */
  host: string | null;
  path: string;
  /** The `pathType` verbatim: nginx's reading of it is nginx's. */
  pathType: string | null;
  /**
   * `null` where the backend is not a Service at all. An Ingress may name an
   * API object instead — `backend.resource` — which has no endpoints by
   * design, and reporting it as a missing Service would be the page
   * inventing an outage out of a working configuration.
   */
  service: { name: string; namespace: string; port: string } | null;
  /** `Kind/name` where this path routes to an API object rather than a Service. */
  resourceBackend: string | null;
  tlsSecret: string | null;
  annotations: AnnotationReading[];
  /** Set only on an Ingress that declares itself one. */
  canary: Canary | null;
  /** For the tie-break nginx itself uses. */
  createdAt: string | null;
}

export type Finding =
  /** The route resolves and there is nothing behind it. */
  | { kind: "stop"; severity: "err"; route: NginxRoute; stop: ChainStop }
  /** Nothing serves this host over TLS at all. */
  | { kind: "clear"; severity: "warn"; redirectAnyway: boolean }
  /** Two objects claim the same host and the same path. */
  | {
      kind: "duplicate";
      severity: "warn";
      path: string;
      routes: NginxRoute[];
      /** nginx settles this one, unlike Traefik: the older Ingress wins. */
      winner: NginxRoute | null;
    }
  /** A canary shadowing a host no other Ingress serves — it does nothing. */
  | { kind: "orphanCanary"; severity: "warn"; route: NginxRoute }
  /** The certificate this host is served under is running out, or unreadable. */
  | {
      kind: "certificate";
      severity: "err" | "warn";
      namespace: string;
      secretName: string;
      read: TlsCertificate | undefined;
      expiry: Expiry | null;
    };

/**
 * How one host's traffic is divided, where a canary divides it.
 *
 * `primaryShare` is stated only where the objects settle it: every canary
 * carrying a weight and nothing carrying a header or cookie rule. A header
 * rule is checked first and takes whatever share of traffic carries that
 * header, which is not a number any object here states.
 */
export interface HostSplit {
  primary: NginxRoute;
  canaries: NginxRoute[];
  primaryShare: number | null;
  weightTotal: number;
}

export interface NginxHostGroup {
  host: string | null;
  routes: NginxRoute[];
  findings: Finding[];
  /** The route the chain is drawn for: the one worth looking at. */
  chainFor: NginxRoute;
  split: HostSplit | null;
  tlsSecrets: SecretRef[];
  worst: "err" | "warn" | null;
}

export interface NginxSources {
  ingresses: IngressInfo[];
  classes: IngressClassSummary[];
  services: ServiceInfo[];
  published: ServicePublished[];
  backingKnown?: boolean;
  certificates?: Map<string, TlsCertificate>;
  /**
   * Whether something in front of this nginx terminates TLS for a host —
   * a cloud load balancer holding the certificate and forwarding plaintext
   * to port 80, which is the ordinary shape of a managed cluster.
   *
   * Answered by the page from the `service.routes` capability, because that
   * certificate usually lives in an annotation no reading of `spec.tls`
   * finds. Absent on a cluster with no such vendor, where
   * {@link terminatedUpstream} is the whole answer.
   */
  upstreamTls?: (host: string | null) => boolean;
}

/** The label an ingress-nginx chart puts on its own pods. */
const PROXY_LABEL = ["app.kubernetes.io/name", "ingress-nginx"] as const;

/**
 * What terminates TLS for this host before it reaches nginx.
 *
 * The same evidence Traefik's page looks for, and needed more often: "cloud
 * load balancer in front, nginx on port 80" is how most managed clusters are
 * built, and the finding below called every host on one of them served in
 * the clear. An Ingress whose backend is a Service selecting nginx's own
 * pods, whose `spec.tls` covers this host — nothing looser, or the warning
 * would go quiet on a cluster where nothing terminates anything.
 */
export function frontingIngresses(sources: NginxSources): IngressInfo[] {
  const proxies = sources.services.filter(
    (service) => service.selector[PROXY_LABEL[0]] === PROXY_LABEL[1]
  );
  if (proxies.length === 0) return [];
  return sources.ingresses.filter((ingress) =>
    ingress.rules.some((rule) =>
      rule.paths.some((path) =>
        proxies.some(
          (service) =>
            service.name === path.backendService &&
            service.namespace === ingress.namespace
        )
      )
    )
  );
}

export function terminatedUpstream(
  host: string | null,
  sources: NginxSources
): { kind: "Ingress"; name: string; namespace: string } | null {
  if (host === null) return null;

  for (const ingress of frontingIngresses(sources)) {
    const terminates =
      ingress.hasCatchAllTls ||
      covers(ingress.tlsHosts, host) ||
      ingress.tlsConfigs.some((config) => covers(config.hosts, host));
    if (!terminates) continue;
    return {
      kind: "Ingress",
      name: ingress.name,
      namespace: ingress.namespace,
    };
  }
  return null;
}

/** The IngressClasses whose controller is this nginx. */
export function nginxClasses(
  classes: IngressClassSummary[]
): IngressClassSummary[] {
  return classesOf(classes, CONTROLLER);
}

// --- reading an Ingress -------------------------------------------------

function canaryOf(annotations: Record<string, string>): Canary | null {
  if (annotations[`${PREFIX}canary`]?.trim().toLowerCase() !== "true") {
    return null;
  }
  const number = (key: string): number | null => {
    const raw = annotations[`${PREFIX}${key}`]?.trim();
    return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const text = (key: string): string | null => {
    const raw = annotations[`${PREFIX}${key}`]?.trim();
    return raw ? raw : null;
  };
  return {
    byHeader: text("canary-by-header"),
    byHeaderValue: text("canary-by-header-value"),
    byCookie: text("canary-by-cookie"),
    weight: number("canary-weight"),
    weightTotal: number("canary-weight-total") ?? 100,
  };
}

function routesFrom(ingress: IngressInfo, index: number, t: T): NginxRoute[] {
  const annotations = readAnnotations(ingress.annotations, t);
  const canary = canaryOf(ingress.annotations);

  const routes = ingress.rules.flatMap((rule, ruleIndex) =>
    rule.paths.map((path, pathIndex) => {
      const host = rule.host || null;
      return {
        key: `${ingress.namespace}/${ingress.name}/${ruleIndex}/${pathIndex}/${index}`,
        source: {
          kind: "Ingress" as const,
          name: ingress.name,
          namespace: ingress.namespace,
        },
        host,
        path: path.path || "/",
        pathType: path.pathType,
        service: path.backendService
          ? {
              name: path.backendService,
              namespace: ingress.namespace,
              port: path.backendPort,
            }
          : null,
        resourceBackend: path.resourceBackend,
        tlsSecret: tlsSecretFor(ingress, host),
        annotations,
        canary,
        createdAt: ingress.createdAt,
      };
    })
  );

  // The same fallback Traefik's table reads: everything unmatched, one
  // Service, and an edge that otherwise served nothing on this page.
  const fallback = ingress.defaultBackend;
  if (fallback?.backendService) {
    routes.push({
      key: `${ingress.namespace}/${ingress.name}/default/${index}`,
      source: {
        kind: "Ingress" as const,
        name: ingress.name,
        namespace: ingress.namespace,
      },
      host: null,
      path: "*",
      pathType: "DefaultBackend",
      service: {
        name: fallback.backendService,
        namespace: ingress.namespace,
        port: fallback.backendPort,
      },
      resourceBackend: fallback.resourceBackend,
      tlsSecret: tlsSecretFor(ingress, null),
      annotations,
      canary,
      createdAt: ingress.createdAt,
    });
  }

  return routes;
}

/** Every route this nginx serves. */
export function allRoutes(sources: NginxSources, t: T): NginxRoute[] {
  return sources.ingresses
    .filter((ingress) => claimsIngress(ingress, sources.classes, CONTROLLER))
    .flatMap((ingress, index) => routesFrom(ingress, index, t));
}

export function backingOf(
  route: NginxRoute,
  sources: Pick<NginxSources, "services" | "published" | "backingKnown">
): Backing {
  return backingOfBackend(route.service, route.source, sources);
}

// --- the findings -------------------------------------------------------

/**
 * Two objects serving the same host *and the same path*.
 *
 * Only exact duplicates: `/` and `/api` on one host overlap and are meant
 * to. A canary is never one of these — it is a second route for the same
 * host **by design**, and reporting the pair as a conflict would make every
 * correctly configured canary in the cluster a finding.
 *
 * Who wins is stated, which Traefik's page cannot do: nginx resolves a
 * conflict by creation time and serves the older Ingress, logging a warning
 * nobody reads.
 */
function duplicateFindings(routes: NginxRoute[]): Finding[] {
  const plain = routes.filter((route) => !route.canary);
  const byPath = new Map<string, NginxRoute[]>();
  for (const route of plain) {
    byPath.set(route.path, [...(byPath.get(route.path) ?? []), route]);
  }

  const findings: Finding[] = [];
  for (const [path, sharing] of byPath) {
    const objects = new Set(
      sharing.map((route) => `${route.source.namespace}/${route.source.name}`)
    );
    if (objects.size < 2) continue;

    const dated = sharing.filter((route) => route.createdAt !== null);
    const winner =
      dated.length === sharing.length
        ? sharing.reduce((oldest, route) =>
            route.createdAt! < oldest.createdAt! ? route : oldest
          )
        : null;

    findings.push({
      kind: "duplicate",
      severity: "warn",
      path,
      routes: sharing,
      winner,
    });
  }
  return findings;
}

/**
 * A host with no encrypted way in.
 *
 * Simpler than the same finding on Traefik's page, and for a good reason:
 * nginx has no entry points to read. It listens on 80 and on 443 always, so
 * "is this host reachable in the clear" is answered entirely by whether any
 * Ingress under it declares a certificate.
 *
 * `redirectAnyway` is the trap worth naming. `ssl-redirect` defaults to true
 * and reads like protection, and it does nothing at all on a host with no
 * TLS block — nginx only applies it where the Ingress has a certificate to
 * redirect *to*. An Ingress carrying `ssl-redirect: "true"` and no `tls:`
 * looks secured and is served entirely in the clear.
 */
function clearFinding(
  routes: NginxRoute[],
  sources: NginxSources,
  host: string | null
): Finding | null {
  if (routes.some((route) => route.tlsSecret)) return null;
  // Something in front holds the certificate; the hop into the cluster is
  // plaintext by design and is not a fault to report per host.
  if (terminatedUpstream(host, sources)) return null;
  if (sources.upstreamTls?.(host)) return null;
  const redirectAnyway = routes.some((route) =>
    route.annotations.some(
      (reading) =>
        (reading.key === `${PREFIX}ssl-redirect` ||
          reading.key === `${PREFIX}force-ssl-redirect`) &&
        reading.value.trim().toLowerCase() === "true"
    )
  );
  return { kind: "clear", severity: "warn", redirectAnyway };
}

const URGENCY: Record<Finding["kind"], number> = {
  stop: 5,
  certificate: 4,
  orphanCanary: 3,
  clear: 2,
  duplicate: 1,
};

function urgencyOf(findings: Finding[]): number {
  return findings.reduce(
    (worst, finding) =>
      Math.max(worst, RANK[finding.severity] * 10 + URGENCY[finding.kind]),
    0
  );
}

/**
 * How a host's traffic is split, where a canary splits it.
 *
 * `null` where there is no canary at all, which is nearly every host.
 */
export function splitOf(routes: NginxRoute[]): HostSplit | null {
  const canaries = routes.filter((route) => route.canary);
  if (canaries.length === 0) return null;
  const primary = routes.find((route) => !route.canary);
  if (!primary) return null;

  const total = canaries[0].canary!.weightTotal;
  const weighed = canaries.every(
    (route) =>
      route.canary!.weight !== null &&
      route.canary!.byHeader === null &&
      route.canary!.byCookie === null &&
      route.canary!.weightTotal === total
  );
  const taken = canaries.reduce(
    (sum, route) => sum + (route.canary!.weight ?? 0),
    0
  );

  return {
    primary,
    canaries,
    primaryShare: weighed && taken <= total ? total - taken : null,
    weightTotal: total,
  };
}

/**
 * The page: one group per host, ordered by trouble.
 *
 * By trouble rather than by name, because the reader who opens this has a
 * URL that is not working and eighty hosts that are.
 */
export function hostGroups(sources: NginxSources, t: T): NginxHostGroup[] {
  const routes = allRoutes(sources, t);
  const byHost = new Map<string, NginxRoute[]>();
  for (const route of routes) {
    const key = route.host ?? "";
    byHost.set(key, [...(byHost.get(key) ?? []), route]);
  }

  const groups = [...byHost.entries()].map(([host, own]) => {
    // One stop per broken backend, not per route that names it: three paths
    // pointing at the same missing Service is one repair.
    const seen = new Set<string>();
    const stops = own.flatMap((route): Finding[] => {
      const stop = backingOf(route, sources).stop;
      if (!stop) return [];
      const key = `${stop.reason}/${stop.service.namespace}/${stop.service.name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ kind: "stop", severity: "err", route, stop }];
    });

    const tlsSecrets = [
      ...new Map(
        own
          .filter((route) => route.tlsSecret)
          .map((route) => [
            `${route.source.namespace}/${route.tlsSecret}`,
            { namespace: route.source.namespace, secretName: route.tlsSecret! },
          ])
      ).values(),
    ];

    const split = splitOf(own);
    // A canary with nothing to shadow is configuration that does nothing at
    // all: nginx merges a canary into the host's existing server block, and
    // where there is no such block it is simply never served.
    const orphans: Finding[] =
      split === null
        ? own
            .filter((route) => route.canary)
            .map((route) => ({
              kind: "orphanCanary" as const,
              severity: "warn" as const,
              route,
            }))
        : [];

    const clear = clearFinding(own, sources, host === "" ? null : host);
    const findings: Finding[] = [
      ...stops,
      ...certificateProblems(tlsSecrets, sources.certificates).map(
        (problem) => ({ kind: "certificate" as const, ...problem })
      ),
      ...orphans,
      ...(clear ? [clear] : []),
      ...duplicateFindings(own),
    ];

    return {
      host: host === "" ? null : host,
      routes: own,
      findings,
      // The route the chain is drawn for: the one that stopped, or failing
      // that the one with the most behaviour on it — a bare `/` straight to
      // a Service is the one the path rows above already say in full.
      chainFor:
        stops[0]?.kind === "stop"
          ? stops[0].route
          : [...own].sort(
              (a, b) => b.annotations.length - a.annotations.length
            )[0],
      split,
      tlsSecrets,
      worst: worstOf(findings),
    };
  });

  return groups.sort(compareGroups);
}

function compareGroups(a: NginxHostGroup, b: NginxHostGroup): number {
  const rank = (group: NginxHostGroup) => urgencyOf(group.findings);
  if (rank(a) !== rank(b)) return rank(b) - rank(a);
  if (a.findings.length !== b.findings.length) {
    return b.findings.length - a.findings.length;
  }
  if ((a.host === null) !== (b.host === null)) return a.host === null ? 1 : -1;
  return (a.host ?? "").localeCompare(b.host ?? "");
}
