/**
 * What this cluster's Traefik serves, pivoted the way the question is asked.
 *
 * Nobody asks "list the IngressRoutes". They ask *what serves this hostname*
 * and *why is this URL not working*, so the unit here is a host and the
 * routes under it — whichever kind of object they came from.
 *
 * ## Two kinds of object, one routing table
 *
 * A page that read only the CRDs would be empty on a k3d cluster and wrong on
 * most real ones: k3d ships Traefik as *the* ingress controller, so plain
 * `Ingress` objects are the majority of what it serves. Which Ingresses are
 * Traefik's is not a guess either — an `IngressClass` carries the controller
 * that claims it, so an Ingress belongs here when it names a class whose
 * controller is Traefik's, or names none and this cluster's default class is
 * Traefik's. Every other Ingress in the cluster is somebody else's problem
 * and is not drawn.
 *
 * ## The findings are the reason the page exists
 *
 * None of them is visible anywhere in this app today: a Service with no
 * endpoints reads healthy on every list page, a host on a plain-HTTP entry
 * point looks like a normal route, and a certificate two objects away is
 * nobody's column. The vocabulary for the first is not reinvented here —
 * {@link ChainStop} is the same union the traffic chain already speaks, so
 * "no pod carries app=promo" reads identically whether it was reached from a
 * Deployment or from a hostname.
 */

import type { Expiry } from "@/lib/certificates";
import type {
  CustomResourceInfo,
  ServicePublished,
  IngressClassSummary,
  IngressInfo,
  ChainStop,
  ServiceInfo,
  TlsCertificate,
} from "@/generated/types";
import {
  backingOf as backingOfBackend,
  certificateProblems,
  claimsIngress as classClaims,
  classesOf,
  SEVERITY_RANK as RANK,
  tlsSecretFor,
  worstOf,
  type Backing,
  type SecretRef,
} from "../ingress";
import { readRule, type RuleClause, type RuleReading } from "./rule";

export type { Backing } from "../ingress";

/** Every version of Traefik writes this into an IngressClass's `spec.controller`. */
export const CONTROLLER = "traefik.io/ingress-controller";

/** Which entry points an Ingress's router is bound to, when it says so. */
const ENTRYPOINTS_ANNOTATION =
  "traefik.ingress.kubernetes.io/router.entrypoints";
/** `namespace-name@kubernetescrd`, comma separated. */
const MIDDLEWARES_ANNOTATION =
  "traefik.ingress.kubernetes.io/router.middlewares";

export interface MiddlewareRef {
  name: string;
  namespace: string;
}

export interface RouteService {
  name: string;
  namespace: string;
  port: string;
  /**
   * Whether this names a Kubernetes Service at all.
   *
   * Traefik routes to its own internals too — `api@internal` serves the
   * dashboard, and a `TraefikService` is a CRD that fans out to several
   * backends. Neither is a Service, neither has endpoints, and reporting
   * "no Service named api@internal in this namespace" about the dashboard
   * this cluster ships with is the page inventing an outage.
   */
  kubernetes: boolean;
}

export interface TraefikRoute {
  key: string;
  source: {
    kind: "Ingress" | "IngressRoute";
    name: string;
    namespace: string;
  };
  rule: RuleReading;
  /** This row's own alternative of the rule. */
  clause: RuleClause;
  /**
   * The entry points the router is bound to, or `null` where the object names
   * none — which for Traefik means *every* entry point, not none of them.
   */
  entryPoints: string[] | null;
  middlewares: MiddlewareRef[];
  service: RouteService | null;
  /**
   * `Kind/name` where an Ingress path routes to an API object rather than a
   * Service — `backend.resource`. A different thing from {@link service}
   * being null on a Traefik internal: that one lives inside the proxy, this
   * one is a Kubernetes object the app simply cannot see inside.
   */
  resourceBackend: string | null;
  tlsSecret: string | null;
  /** An Ingress's `pathType` verbatim: Traefik's reading of it is Traefik's. */
  pathType: string | null;
  /** An IngressRoute may state one; an Ingress never does. */
  priority: number | null;
}

export interface EntryPoint {
  name: string;
  address: string | null;
  tls: boolean;
  /** Where plain requests on it are sent instead, where a redirection is set. */
  redirectTo: string | null;
}

export type Finding =
  /** The route resolves and there is nothing behind it. */
  | { kind: "stop"; severity: "err"; route: TraefikRoute; stop: ChainStop }
  /** Reachable unencrypted, and nothing upgrades the connection. */
  | {
      kind: "clear";
      severity: "warn";
      entryPoints: string[];
      alsoOnTls: boolean;
    }
  /** Two objects claim the same host and the same path. */
  | {
      kind: "duplicate";
      severity: "warn";
      path: string;
      routes: TraefikRoute[];
      /** `null` where the objects do not settle it, which is said out loud. */
      winner: TraefikRoute | null;
    }
  /** The certificate this host is served under is running out, or unreadable. */
  | {
      kind: "certificate";
      severity: "err" | "warn";
      namespace: string;
      secretName: string;
      read: TlsCertificate | undefined;
      expiry: Expiry | null;
    };

export interface HostGroup {
  /** `null` is a route with no host term — a catch-all, drawn last. */
  host: string | null;
  routes: TraefikRoute[];
  findings: Finding[];
  /** The route the chain is drawn for: the one worth looking at. */
  chainFor: TraefikRoute;
  /** Every TLS Secret any route under this host is served under. */
  tlsSecrets: Array<{ namespace: string; secretName: string }>;
  worst: "err" | "warn" | null;
}

export interface TraefikSources {
  ingresses: IngressInfo[];
  ingressRoutes: CustomResourceInfo[];
  classes: IngressClassSummary[];
  services: ServiceInfo[];
  published: ServicePublished[];
  middlewares: CustomResourceInfo[];
  /**
   * Whether {@link services} and {@link published} have actually been read.
   *
   * They arrive in a second request, and an empty list means "not yet" as
   * readily as it means "none". Without this the page spends the second
   * between the two answers telling the reader that every backend in the
   * cluster is missing, which is a worse lie than saying nothing.
   */
  backingKnown?: boolean;
  /** Empty where the controller's own configuration could not be read. */
  entryPoints: EntryPoint[];
  /** Certificates already read off the TLS Secrets, by `namespace/name`. */
  certificates?: Map<string, TlsCertificate>;
}

// --- which Ingresses are this Traefik's ---------------------------------

/** The IngressClasses whose controller is Traefik. */
export function traefikClasses(
  classes: IngressClassSummary[]
): IngressClassSummary[] {
  return classesOf(classes, CONTROLLER);
}

export function claimsIngress(
  ingress: IngressInfo,
  classes: IngressClassSummary[]
): boolean {
  return classClaims(ingress, classes, CONTROLLER);
}

// --- reading the two kinds of object ------------------------------------

/**
 * `namespace-name@kubernetescrd` is Traefik's own spelling, and the separator
 * between the two halves is the same hyphen a namespace and a name may both
 * contain: `k8s-gui-test-strip-prefix` splits six ways and only one of them
 * is right. So it is not split at all — it is *matched* against the
 * middlewares this cluster actually has, and a reference that matches none of
 * them keeps the string as written rather than being cut at a guess.
 */
function middlewaresFromAnnotation(
  value: string | undefined,
  fallbackNamespace: string,
  known: CustomResourceInfo[]
): MiddlewareRef[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().split("@")[0])
    .filter(Boolean)
    .map((bare) => {
      const match = known.find(
        (middleware) =>
          `${middleware.namespace ?? ""}-${middleware.name}` === bare
      );
      if (match) {
        return { name: match.name, namespace: match.namespace ?? "" };
      }
      return { name: bare, namespace: fallbackNamespace };
    });
}

function routesFromIngress(
  ingress: IngressInfo,
  index: number,
  known: CustomResourceInfo[]
): TraefikRoute[] {
  const entryAnnotation = ingress.annotations[ENTRYPOINTS_ANNOTATION];
  const entryPoints = entryAnnotation
    ? entryAnnotation
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : null;
  const middlewares = middlewaresFromAnnotation(
    ingress.annotations[MIDDLEWARES_ANNOTATION],
    ingress.namespace,
    known
  );

  return ingress.rules.flatMap((rule, ruleIndex) =>
    rule.paths.map((path, pathIndex) => {
      const host = rule.host || null;
      const clause: RuleClause = {
        host,
        // Traefik's Ingress provider reads `Exact` as `Path` and everything
        // else as `PathPrefix`. The word as written is kept beside it rather
        // than dropped, because that mapping is the controller's and a reader
        // comparing this page with their YAML has to see their own word.
        path: {
          kind: path.pathType === "Exact" ? "exact" : "prefix",
          value: path.path || "/",
        },
      };
      return {
        key: `ingress/${ingress.namespace}/${ingress.name}/${ruleIndex}/${pathIndex}/${index}`,
        source: {
          kind: "Ingress" as const,
          name: ingress.name,
          namespace: ingress.namespace,
        },
        // An Ingress states its host and path in fields. There is no rule
        // text to misread, so there is none to fall back to either.
        rule: { raw: null, clauses: [clause], unread: [], refused: null },
        clause,
        entryPoints,
        middlewares,
        // An Ingress may name an API object instead of a Service —
        // `backend.resource` — and then the Service name is empty. Reading it
        // through would report "no Service named  in this namespace" about a
        // configuration that works, with a blank where the name goes.
        service: path.backendService
          ? {
              name: path.backendService,
              namespace: ingress.namespace,
              port: path.backendPort,
              kubernetes: true,
            }
          : null,
        resourceBackend: path.resourceBackend,
        tlsSecret: tlsSecretFor(ingress, host),
        pathType: path.pathType,
        priority: null,
      };
    })
  );
}

interface IngressRouteSpec {
  entryPoints?: string[];
  routes?: Array<{
    match?: string;
    priority?: number;
    services?: Array<{
      name?: string;
      namespace?: string;
      port?: unknown;
      kind?: string;
    }>;
    middlewares?: Array<{ name?: string; namespace?: string }>;
  }>;
  tls?: { secretName?: string };
}

function routesFromIngressRoute(object: CustomResourceInfo): TraefikRoute[] {
  const spec = (object.spec ?? {}) as IngressRouteSpec;
  const namespace = object.namespace ?? "";
  const entryPoints = spec.entryPoints?.length ? spec.entryPoints : null;
  const tlsSecret = spec.tls?.secretName ?? null;

  return (spec.routes ?? []).flatMap((route, routeIndex) => {
    const reading = readRule(route.match ?? "");
    const service = route.services?.[0];
    const common = {
      source: {
        kind: "IngressRoute" as const,
        name: object.name,
        namespace,
      },
      rule: reading,
      entryPoints,
      middlewares: (route.middlewares ?? []).flatMap((middleware) =>
        middleware.name
          ? [
              {
                name: middleware.name,
                namespace: middleware.namespace ?? namespace,
              },
            ]
          : []
      ),
      service: service?.name
        ? {
            name: service.name,
            namespace: service.namespace ?? namespace,
            port: service.port === undefined ? "" : String(service.port),
            // `@` is Traefik's own provider qualifier and can never appear in
            // a Kubernetes object name, so it is an unambiguous marker.
            kubernetes:
              service.kind !== "TraefikService" && !service.name.includes("@"),
          }
        : null,
      // Only an Ingress can name one; an IngressRoute has no such field.
      resourceBackend: null,
      tlsSecret,
      pathType: null,
      priority: route.priority ?? null,
    };

    // A rule that could not be read still gets a row: it is a route this
    // cluster is serving, and hiding it would be the page lying by omission.
    // It is filed under no host, which is where a rule with no readable host
    // honestly belongs.
    const clauses: RuleClause[] =
      reading.clauses.length > 0
        ? reading.clauses
        : [{ host: null, path: null }];

    return clauses.map((clause, clauseIndex) => ({
      ...common,
      key: `ingressroute/${namespace}/${object.name}/${routeIndex}/${clauseIndex}`,
      clause,
    }));
  });
}

// --- entry points, read off the controller's own arguments --------------

/**
 * Traefik's entry points are static configuration: they exist only in the
 * flags the proxy was started with, which is why nothing in a cluster can
 * answer "what does this listen on" without reading the workload itself.
 */
export function readEntryPoints(args: string[]): EntryPoint[] {
  const found = new Map<string, EntryPoint>();

  const at = (name: string): EntryPoint => {
    const existing = found.get(name);
    if (existing) return existing;
    const made: EntryPoint = {
      name,
      address: null,
      tls: false,
      redirectTo: null,
    };
    found.set(name, made);
    return made;
  };

  for (const arg of args) {
    const [rawKey, rawValue] = arg.replace(/^-+/, "").split("=", 2);
    const parts = rawKey.split(".");
    if (parts.length < 3) continue;
    if (parts[0].toLowerCase() !== "entrypoints") continue;

    const name = parts[1];
    const tail = parts
      .slice(2)
      .map((part) => part.toLowerCase())
      .join(".");
    const value = rawValue ?? "true";

    if (tail === "address") at(name).address = value.split("/")[0];
    else if (tail === "http.tls" || tail.startsWith("http.tls.")) {
      if (value !== "false") at(name).tls = true;
    } else if (tail === "http.redirections.entrypoint.to") {
      at(name).redirectTo = value;
    } else if (tail.startsWith("http.redirections.")) {
      // A redirection block with only a scheme still redirects; the target
      // is unknown, and saying "somewhere" beats saying nothing.
      const entry = at(name);
      entry.redirectTo = entry.redirectTo ?? "another entry point";
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The entry points a route is actually bound to. */
export function boundEntryPoints(
  route: TraefikRoute,
  entryPoints: EntryPoint[]
): EntryPoint[] {
  if (!route.entryPoints) return entryPoints;
  return entryPoints.filter((entry) => route.entryPoints!.includes(entry.name));
}

// --- what is behind a route ---------------------------------------------

export function backingOf(
  route: TraefikRoute,
  sources: Pick<TraefikSources, "services" | "published" | "backingKnown">
): Backing {
  // Nothing is claimed about a backend that is not a Kubernetes object: it
  // has no endpoints by design, and the app cannot see inside it.
  const backend =
    route.service && route.service.kubernetes
      ? { name: route.service.name, namespace: route.service.namespace }
      : null;
  return backingOfBackend(backend, route.source, sources);
}

// --- middlewares --------------------------------------------------------

/** The one middleware type that turns a plain-HTTP route into a secure one. */
export function isRedirect(middleware: CustomResourceInfo): boolean {
  const spec = (middleware.spec ?? {}) as Record<string, unknown>;
  if (spec.redirectScheme) return true;
  if (spec.redirectRegex) return true;
  return false;
}

/** What kind of middleware this is, from the one key its spec carries. */
export function middlewareType(middleware: CustomResourceInfo): string | null {
  const spec = (middleware.spec ?? {}) as Record<string, unknown>;
  const keys = Object.keys(spec);
  return keys.length > 0 ? keys[0] : null;
}

export interface MiddlewareUse {
  middleware: CustomResourceInfo;
  type: string | null;
  /** Every route that names it. Empty is the finding. */
  usedBy: TraefikRoute[];
}

export function middlewareUses(
  middlewares: CustomResourceInfo[],
  routes: TraefikRoute[]
): MiddlewareUse[] {
  const uses = middlewares.map((middleware) => ({
    middleware,
    type: middlewareType(middleware),
    usedBy: routes.filter((route) =>
      route.middlewares.some(
        (named) =>
          named.name === middleware.name &&
          named.namespace === (middleware.namespace ?? "")
      )
    ),
  }));
  // Unused first: it is the only row on the tab that is a finding rather
  // than inventory.
  return uses.sort((a, b) => {
    if (a.usedBy.length !== b.usedBy.length) {
      return a.usedBy.length - b.usedBy.length;
    }
    return a.middleware.name.localeCompare(b.middleware.name);
  });
}

// --- the hosts ----------------------------------------------------------

/**
 * How far up the page a finding pulls its host, within one severity.
 *
 * A path that stops is an outage happening now; a certificate with three
 * days left is an outage on Thursday. Both are `err`, and printing them in
 * alphabetical order would put Thursday first about half the time.
 */
const URGENCY: Record<Finding["kind"], number> = {
  stop: 4,
  certificate: 3,
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

/** Every route this Traefik serves, from both kinds of object. */
export function allRoutes(sources: TraefikSources): TraefikRoute[] {
  const fromIngresses = sources.ingresses
    .filter((ingress) => claimsIngress(ingress, sources.classes))
    .flatMap((ingress, index) =>
      routesFromIngress(ingress, index, sources.middlewares)
    );
  const fromCrds = sources.ingressRoutes.flatMap(routesFromIngressRoute);
  return [...fromIngresses, ...fromCrds];
}

/**
 * Two objects serving the same host *and the same path*, which is the case
 * where one of them silently never fires.
 *
 * Only exact duplicates. `/` and `/api` on one host overlap and are meant to
 * — that is how a route is made more specific — and calling it a finding
 * would bury the real one under every well-configured site in the cluster.
 *
 * Who wins is stated only when the objects settle it. Traefik orders routers
 * by priority, and an unset priority defaults to the length of the rule
 * *Traefik generated*, which for an Ingress this app never sees. So an
 * explicit `priority` on both IngressRoutes gives an answer, and anything
 * else is reported as ambiguous rather than guessed.
 */
function duplicateFindings(routes: TraefikRoute[]): Finding[] {
  const byPath = new Map<string, TraefikRoute[]>();
  for (const route of routes) {
    const path = route.clause.path
      ? `${route.clause.path.kind}:${route.clause.path.value}`
      : "any";
    byPath.set(path, [...(byPath.get(path) ?? []), route]);
  }

  const findings: Finding[] = [];
  for (const [path, sharing] of byPath) {
    const objects = new Set(
      sharing.map(
        (route) =>
          `${route.source.kind}/${route.source.namespace}/${route.source.name}`
      )
    );
    if (objects.size < 2) continue;

    const priorities = sharing.filter((route) => route.priority !== null);
    const winner =
      priorities.length === sharing.length
        ? sharing.reduce((best, route) =>
            (route.priority ?? 0) > (best.priority ?? 0) ? route : best
          )
        : null;

    findings.push({
      kind: "duplicate",
      severity: "warn",
      path: path.startsWith("exact:")
        ? `${path.slice(6)} (exact)`
        : path === "any"
          ? "every path"
          : path.slice(7),
      routes: sharing,
      winner,
    });
  }
  return findings;
}

/**
 * A host served with no encryption at all.
 *
 * Narrower than "reachable over plain HTTP", deliberately. Traefik's Ingress
 * provider binds a router with no declared entry point to *every* entry
 * point, so on a cluster whose `web` carries no redirection every host in it
 * is also reachable unencrypted — which is one fact about the proxy, not
 * eighty findings about eighty hosts. That one belongs on the Entry points
 * tab and is stated there once.
 *
 * What is a finding about *this* host is that nothing serves it over TLS at
 * all: no route under it carries a certificate, so there is no encrypted way
 * to reach it even for a client that asks for one.
 */
function clearFinding(
  routes: TraefikRoute[],
  sources: TraefikSources
): Finding | null {
  if (routes.some((route) => route.tlsSecret)) return null;
  // Nothing is claimed about entry points the controller never told us about:
  // an empty list means the workload could not be read, not that it listens
  // on nothing.
  if (sources.entryPoints.length === 0) return null;

  const bound = new Map<string, EntryPoint>();
  for (const route of routes) {
    for (const entry of boundEntryPoints(route, sources.entryPoints)) {
      bound.set(entry.name, entry);
    }
  }

  const plain = [...bound.values()].filter(
    (entry) => !entry.tls && entry.redirectTo === null
  );
  if (plain.length === 0) return null;

  // A redirect middleware on any route under the host upgrades it, which is
  // the other way the same problem is solved.
  const redirecting = sources.middlewares.filter(isRedirect);
  const carriesRedirect = routes.some((route) =>
    route.middlewares.some((named) =>
      redirecting.some(
        (middleware) =>
          middleware.name === named.name &&
          (middleware.namespace ?? "") === named.namespace
      )
    )
  );
  if (carriesRedirect) return null;

  return {
    kind: "clear",
    severity: "warn",
    entryPoints: plain.map((entry) => entry.name),
    alsoOnTls: [...bound.values()].some((entry) => entry.tls),
  };
}

function certificateFindings(
  secrets: SecretRef[],
  certificates: Map<string, TlsCertificate> | undefined
): Finding[] {
  return certificateProblems(secrets, certificates).map((problem) => ({
    kind: "certificate",
    ...problem,
  }));
}

/**
 * The page: one group per host, ordered by trouble.
 *
 * By trouble rather than by name, because the reader who opens this has a
 * URL that is not working and eighty hosts that are. Alphabetical order puts
 * the answer wherever the alphabet happens to put it.
 */
export function hostGroups(sources: TraefikSources): HostGroup[] {
  const routes = allRoutes(sources);
  const byHost = new Map<string, TraefikRoute[]>();
  for (const route of routes) {
    const key = route.clause.host ?? "";
    byHost.set(key, [...(byHost.get(key) ?? []), route]);
  }

  const groups: HostGroup[] = [...byHost.entries()].map(([host, own]) => {
    // One stop per broken backend, not per route that names it: three paths
    // pointing at the same missing Service is one repair, and printing the
    // same sentence three times spends the reader's attention on nothing.
    const seenStops = new Set<string>();
    const stops = own.flatMap((route): Finding[] => {
      const stop = backingOf(route, sources).stop;
      if (!stop) return [];
      const key = `${stop.reason}/${stop.service.namespace}/${stop.service.name}`;
      if (seenStops.has(key)) return [];
      seenStops.add(key);
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

    const clear = clearFinding(own, sources);
    const findings = [
      ...stops,
      ...certificateFindings(tlsSecrets, sources.certificates),
      ...(clear ? [clear] : []),
      ...duplicateFindings(own),
    ];

    return {
      host: host === "" ? null : host,
      routes: own,
      findings,
      // The route the chain is drawn for: the one that stopped, or failing
      // that the one with the most to show. Drawing one chain per path would
      // turn a host with twenty paths into a wall, and the reader came for
      // either the broken path or the one with something in the middle of it
      // — a bare `/` straight to a Service is the one the path rows above
      // already say in full.
      chainFor:
        stops[0]?.kind === "stop"
          ? stops[0].route
          : [...own].sort(
              (a, b) => b.middlewares.length - a.middlewares.length
            )[0],
      tlsSecrets,
      worst: worstOf(findings),
    };
  });

  return groups.sort(compareGroups);
}

function compareGroups(a: HostGroup, b: HostGroup): number {
  const rank = (group: HostGroup) => urgencyOf(group.findings);
  if (rank(a) !== rank(b)) return rank(b) - rank(a);
  if (a.findings.length !== b.findings.length) {
    return b.findings.length - a.findings.length;
  }
  // A catch-all sorts after every named host: it is the least specific
  // answer to "what serves this hostname".
  if ((a.host === null) !== (b.host === null)) return a.host === null ? 1 : -1;
  return (a.host ?? "").localeCompare(b.host ?? "");
}
