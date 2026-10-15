/**
 * What every routing page in this tree does the same way.
 *
 * Traefik, ingress-nginx and Istio answer three different questions with
 * three different object models over the same two facts: **an Ingress belongs
 * to the controller whose class claims it**, and **a route is only as healthy
 * as what the Service behind it publishes**. A third copy of "does this
 * Service have any ready endpoints" is how two pages start disagreeing about
 * whether the same Service is broken.
 *
 * Deliberately *not* here: anything that decides what a route means.
 * Traefik's entry points, nginx's annotations and Istio's subsets are each
 * vendor's own, and a helper holding all three would hold none honestly.
 */

import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { errorToShow, isRefusal } from "@/lib/error-utils";
import { isReadDeadline, LIST_DEADLINE_SECONDS } from "@/lib/read-deadline";
import type { Saying } from "@/i18n/say";
import { refusedStop, type DoorClaim, type DoorRead } from "@/lib/policy-door";
import type { T } from "@/i18n/useT";
import type { AppLink } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";
import { covers, expiryOf, type Expiry } from "@/lib/certificates";
import { stopMood, type StopMood } from "@/lib/stop-mood";
import type { MapTone } from "./routing-map";
import type { RowTone } from "./page-kit";
import { certificatesOf } from "@/hooks/useTlsCertificates";
import type {
  ChainStop,
  DeploymentContainerInfo,
  IngressClassSummary,
  IngressInfo,
  ObjectRef,
  ServiceInfo,
  ServicePublished,
  TlsCertificate,
} from "@/generated/types";

// --- which Ingresses are this controller's ------------------------------

/** The IngressClasses whose `spec.controller` is this implementation. */
export function classesOf(
  classes: IngressClassSummary[],
  controller: string
): IngressClassSummary[] {
  return classes.filter((entry) => entry.controller === controller);
}

/**
 * Whether this controller serves that Ingress.
 *
 * Not a guess: an `IngressClass` carries the controller that claims it, so
 * an Ingress belongs to an implementation when it names a class whose
 * controller is that implementation's, or names none and this cluster's
 * default class is one of them. Every other Ingress in the cluster is
 * somebody else's problem and is not drawn.
 */
export function claimsIngress(
  ingress: IngressInfo,
  classes: IngressClassSummary[],
  controller: string
): boolean {
  const mine = classesOf(classes, controller);
  if (ingress.className) {
    return mine.some((entry) => entry.name === ingress.className);
  }
  return mine.some((entry) => entry.isDefault);
}

/**
 * The Secret an Ingress serves that host under, where it names one.
 *
 * Matched with {@link covers} rather than by equality: a wildcard in
 * `spec.tls[].hosts` is the ordinary way to write this, a pair of
 * `*.example.com` and `example.com` on one Secret. Compared literally, every
 * subdomain that pair exists to serve came back with no Secret, and the
 * surfaces above then said the host was served in the clear — an outage and a
 * security problem that are not there.
 */
export function tlsSecretFor(
  ingress: IngressInfo,
  host: string | null
): string | null {
  for (const config of ingress.tlsConfigs) {
    if (config.isCatchAll || (host !== null && covers(config.hosts, host))) {
      return config.secretName;
    }
  }
  return null;
}

// --- what is behind a route ---------------------------------------------

/** A backend named by a route, in the two coordinates a Service has. */
export interface BackendRef {
  name: string;
  namespace: string;
  /** The Service port it names, a number or a name, where the route says. */
  port?: string | null;
}

/**
 * The stops this helper can produce: the ones anchored on a Service.
 *
 * `ChainStop` grew Gateway API variants that stop at a route or a Gateway
 * instead, and they are not this function's to make — narrowing here keeps
 * every consumer's `stop.service` access honest instead of asking each of
 * them to re-prove it.
 */
export type ServiceStop = Extract<ChainStop, { service: ObjectRef }>;

export interface Backing {
  service: ServiceInfo | undefined;
  /** Addresses taking traffic — the ready ones and the draining ones. */
  ready: number;
  /** `serving: true, ready: false`: a pod finishing its open connections.
   *  Traffic still flows here, so it is never counted as an outage. */
  draining: number;
  notReady: number;
  /** Set only where the path stops. */
  stop: ServiceStop | null;
  /** False while the Services and their slices are still being read, or
   *  since they could not be. */
  known: boolean;
  /** Why they could not be, in the cluster's words; null while reading. */
  error: string | null;
}

export interface BackingSources {
  services: ServiceInfo[];
  published: ServicePublished[];
  /**
   * Whether {@link services} and {@link published} have actually been read.
   *
   * They arrive in a second request, and an empty list means "not yet" as
   * readily as it means "none". Without this a page spends the second
   * between the two answers telling the reader that every backend in the
   * cluster is missing, which is a worse lie than saying nothing.
   *
   * Required: optional, forgetting it meant "known".
   */
  backingKnown: boolean;
  /** Why they were not read, where they could not be; null while reading. */
  backingError: string | null;
  /** The page's own controller, judged at each backend's NetworkPolicies; absent, nobody is. */
  door?: DoorRead | null;
}

/** For a caller that counts routes and never reads what is behind them. */
export const BACKING_NOT_READ: BackingSources = {
  services: [],
  published: [],
  backingKnown: false,
  backingError: null,
};

/**
 * The lists as every page carries them. Eight places built this object by
 * hand, and a refused read showed as "reading endpoints" for good.
 */
export function backingFrom(
  data: BackingLists | undefined,
  error: unknown,
  door?: DoorRead | null
): BackingSources {
  return {
    services: data?.services ?? [],
    published: data?.published ?? [],
    backingKnown: data !== undefined,
    backingError: data === undefined && error ? errorToShow(error) : null,
    door,
  };
}

/**
 * A host's place in a list ordered by trouble. With nothing found and its
 * backends unread, "fine" is not what is known — every row, map node and tab
 * mark drawn from it read that as green.
 */
export function hostSeverity(group: {
  worst: "err" | "warn" | null;
  backendsKnown: boolean;
  tls: { at: string };
}): "err" | "warn" | "unknown" | null {
  return (
    group.worst ??
    (group.backendsKnown && group.tls.at !== "unknown" ? null : "unknown")
  );
}

/** `hostSeverity` as a report colours it: a host nobody could check is neutral, never green. */
export function hostRole(
  group: Parameters<typeof hostSeverity>[0]
): "err" | "warn" | "neutral" | null {
  const severity = hostSeverity(group);
  return severity === "unknown" ? "neutral" : severity;
}

function ref(kind: string, name: string, namespace: string): ObjectRef {
  return { kind, name, namespace, existence: "present", facts: null };
}

/**
 * What a route's backend publishes, and where the path stops when it does.
 *
 * `from` is the object the route came from, named only so a stop can say
 * which Ingress, IngressRoute or VirtualService led to it — the vocabulary
 * is {@link ChainStop}, the same union the traffic chain already speaks, so
 * "no pod carries app=promo" reads identically wherever it was reached from.
 */
export function backingOf(
  backend: BackendRef | null,
  from: { kind: string; name: string; namespace: string },
  sources: BackingSources
): Backing {
  const known = sources.backingKnown;
  const error = known ? null : sources.backingError;
  const empty: Backing = {
    service: undefined,
    ready: 0,
    draining: 0,
    notReady: 0,
    stop: null,
    known,
    error,
  };
  if (!backend || !known) return empty;

  const service = sources.services.find(
    (candidate) =>
      candidate.name === backend.name &&
      candidate.namespace === backend.namespace
  );

  if (!service) {
    return {
      ...empty,
      stop: {
        reason: "backendMissing",
        ingress: ref(from.kind, from.name, from.namespace),
        service: {
          ...ref("Service", backend.name, backend.namespace),
          existence: "missing",
        },
      },
    };
  }

  // What the Service publishes, and where a path into it stops, by Rust's
  // `service_stop` — the rule the connections graph uses, so a route reading
  // as broken here reads as broken there, in the same words.
  const published = sources.published.find(
    (candidate) =>
      candidate.service.name === service.name &&
      candidate.service.namespace === service.namespace
  );
  const stop =
    published?.stop ??
    refusedStop(published, backend.port ?? null, sources.door);
  return {
    service,
    ready: published?.ready ?? 0,
    draining: published?.draining ?? 0,
    notReady: published?.notReady ?? 0,
    stop: stop && "service" in stop ? stop : null,
    known,
    error,
  };
}

/**
 * A stopped backend's weight, in the mood the traffic chain draws the stop
 * in. Every request still fails, so each is a finding; only a fault is an
 * error, and a Service scaled to zero, starting or unread is not one.
 */
const STOP_WEIGHT: Record<
  StopMood,
  { severity: "err" | "warn"; tone: MapTone; row: RowTone }
> = {
  fault: { severity: "err", tone: "err", row: "err" },
  coming: { severity: "warn", tone: "warn", row: "warn" },
  idle: { severity: "warn", tone: "mute", row: "warn" },
  unchecked: { severity: "warn", tone: "unknown", row: "unknown" },
};

export const stopWeight = (stop: ChainStop) => STOP_WEIGHT[stopMood(stop)];

/** A host line over stopped paths, in the worst of their tones; null when none stopped. */
export function stopsRowTone(stops: ChainStop[]): RowTone | null {
  const tones = new Set(stops.map((stop) => stopWeight(stop).row));
  return (
    (["err", "warn", "unknown"] as const).find((tone) => tones.has(tone)) ??
    null
  );
}

/**
 * A host line over stopped paths: its worst tone, and "shut" where every
 * stop in that tone is a policy, since there are pods behind it.
 */
export function stopsRowState(
  stops: ChainStop[],
  t: T
): { text: string; tone: RowTone } | null {
  const tone = stopsRowTone(stops);
  if (!tone) return null;
  const shut = stops
    .filter((stop) => stopWeight(stop).row === tone)
    .every((stop) => stop.reason === "policyRefuses");
  return {
    text: t("empty", shut ? "stopPolicyShutUnder" : "nothingBehindIt"),
    tone,
  };
}

/** The `Cell` flags a stopped backend is drawn with. */
export function stopCellLook(stop: ChainStop) {
  const { tone } = stopWeight(stop);
  return {
    bad: tone === "err",
    warn: tone === "warn",
    unknown: tone === "unknown",
  };
}

/** The two lists every routing page needs to say what is behind a route. */
export interface BackingLists {
  services: ServiceInfo[];
  published: ServicePublished[];
  /** When the lists were asked for, where the read says. */
  readAt?: string;
}

/** A minute: routing changes with a deploy, not by the second. */
export const ROUTING_STALE = 60_000;

/**
 * Every Service in the cluster and what each publishes.
 *
 * One query key for every routing page there will ever be, deliberately.
 * The lists are identical whoever asked for them, and a reader who looks at
 * Traefik's page and then at nginx's should not pay for the same two
 * cluster-wide reads twice.
 */
export const backingListsKey = (context: string | null) => [
  context,
  "routing",
  "backing",
];

export function useBackingLists(enabled = true) {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: backingListsKey(context),
    queryFn: (): Promise<BackingLists> => commands.listServiceBacking(null),
    staleTime: ROUTING_STALE,
    enabled,
  });
}

/**
 * A controller's containers, as its workload's template declares them.
 *
 * Both ingress controllers keep something here that exists nowhere in the
 * API server — Traefik's entry points, nginx's `--configmap` — so both read
 * the workload, and neither should have its own idea of where a container's
 * arguments live.
 */
export async function controllerContainers(
  workload: Pick<ControllerWorkload, "kind" | "name" | "namespace">
): Promise<DeploymentContainerInfo[]> {
  const detail =
    workload.kind === "Deployment"
      ? await commands.getDeployment(workload.name, workload.namespace)
      : await commands.getDaemonset(workload.name, workload.namespace);
  return detail.containers;
}

/** The flags a controller's process was started with. */
export function workloadArgs(containers: DeploymentContainerInfo[]): string[] {
  return containers.flatMap((container) => [
    ...container.command,
    ...container.args,
  ]);
}

/**
 * The container environment those arguments are expanded against.
 *
 * `--configmap=$(POD_NAMESPACE)/ingress-nginx-controller` is what the static
 * manifest actually says, and the kubelet substitutes it at start. Reading
 * the flag without doing the same substitution names a ConfigMap in a
 * namespace called `$(POD_NAMESPACE)`, which does not exist.
 */
export function workloadEnv(
  containers: DeploymentContainerInfo[]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const container of containers) {
    for (const entry of container.env) {
      if (entry.value !== null) env[entry.name] = entry.value;
    }
  }
  return env;
}

/** `$(NAME)` replaced where the environment says what it is. */
export function expandEnv(
  value: string,
  env: Record<string, string>,
  fallbacks: Record<string, string> = {}
): string {
  return value.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (whole, name) => {
    const replacement = env[name] ?? fallbacks[name];
    return replacement ?? whole;
  });
}

// --- certificates -------------------------------------------------------

export interface SecretRef {
  namespace: string;
  secretName: string;
}

/** A certificate worth saying something about, and nothing about the rest. */
export interface CertificateProblem extends SecretRef {
  severity: "err" | "warn";
  read: TlsCertificate | undefined;
  /** `null` where there is no certificate we could read, the Secret absent included. */
  expiry: Expiry | null;
}

/**
 * The TLS Secrets these routes are served under that are worth a finding.
 *
 * Silent outside {@link expiryOf}'s thresholds on purpose — the same rule
 * every certificate surface uses, scaled to the certificate's lifetime so a
 * seven-day one is not a permanent finding. Colouring a certificate with
 * sixty days left teaches the reader to stop looking at the one that says
 * four.
 */
export function certificateProblems(
  secrets: SecretRef[],
  certificates: Map<string, TlsCertificate> | undefined
): CertificateProblem[] {
  if (!certificates) return [];
  return secrets.flatMap((secret): CertificateProblem[] => {
    const read = certificates.get(`${secret.namespace}/${secret.secretName}`);
    if (!read) return [];

    if (!read.certificate) {
      const missing = read.problem?.says === "noSecret";
      return [
        { ...secret, severity: missing ? "err" : "warn", read, expiry: null },
      ];
    }

    const expiry = expiryOf(read.certificate);
    if (expiry.tone === null) return [];
    return [
      {
        ...secret,
        severity: expiry.tone === "err" ? "err" : "warn",
        read,
        expiry,
      },
    ];
  });
}

// --- what stands in front of the proxy ----------------------------------

/** The proxy's own Services: the ones whose pods carry its chart label. */
export function proxyServicesBy(
  services: readonly ServiceInfo[],
  [key, value]: readonly [string, string]
): ServiceInfo[] {
  return services.filter((service) => service.selector[key] === value);
}

/**
 * Every Ingress whose backend is one of the proxy's own Services — what a
 * cloud load balancer's Ingress looks like from in here.
 */
export function frontingIngressesOf(
  ingresses: readonly IngressInfo[],
  proxies: readonly ServiceInfo[]
): IngressInfo[] {
  if (proxies.length === 0) return [];
  return ingresses.filter((ingress) =>
    proxies.some(
      (service) =>
        service.namespace === ingress.namespace &&
        // `spec.defaultBackend` is the ordinary spelling on a managed
        // cluster: the load balancer names no rules and sends everything
        // to the proxy. Read through `rules` alone it fronts nothing.
        (service.name === ingress.defaultBackend?.backendService ||
          ingress.rules.some((rule) =>
            rule.paths.some((path) => service.name === path.backendService)
          ))
    )
  );
}

/**
 * What a cloud controller is asked about each Ingress in front: its own rule
 * hosts, and for one sending everything to the proxy through
 * `spec.defaultBackend`, every host the proxy serves — the load balancer's
 * certificate is for those, and the Ingress names none of them.
 */
export function frontingQuestions(
  fronting: readonly IngressInfo[],
  proxies: readonly ServiceInfo[],
  served: readonly string[]
): Array<{ namespace: string; name: string; hosts: string[] }> {
  return fronting.map((ingress) => {
    const own = ingress.rules.flatMap((rule) => (rule.host ? [rule.host] : []));
    const everything = proxies.some(
      (service) =>
        service.namespace === ingress.namespace &&
        service.name === ingress.defaultBackend?.backendService
    );
    return {
      namespace: ingress.namespace,
      name: ingress.name,
      hosts: [...new Set(everything ? [...own, ...served] : own)],
    };
  });
}

/**
 * Where TLS ends for a host that holds no certificate of its own: at an
 * Ingress in front, at a cloud controller in front, nowhere — or not known,
 * because the Services or what stands in front could not be read.
 */
export type EdgeTls =
  | { at: "ingress"; name: string }
  | { at: "edge" }
  | { at: "none" }
  | { at: "unknown" };

export function edgeTlsOf(
  host: string | null,
  sources: BackingSources & {
    upstreamTls?: (host: string | null) => boolean | "unknown";
  },
  fronting: readonly IngressInfo[]
): EdgeTls {
  const upstream = terminatedUpstreamOf(host, fronting);
  if (upstream) return { at: "ingress", name: upstream.name };
  const said = sources.upstreamTls?.(host);
  if (said === true) return { at: "edge" };
  if (!sources.backingKnown || said === "unknown") return { at: "unknown" };
  return { at: "none" };
}

/**
 * A host's TLS, worked out once in the model and read by everything that
 * says it: the row, the map tag, the state, the severity and the counts.
 * Each used to ask its own question, and one row said "no TLS" on the left
 * and "TLS not checked" on the right.
 */
export type HostTls =
  | { at: "own"; secret: string | null; missing: boolean }
  | EdgeTls;

/** TLS a host's own routes terminate, under the first Secret they name. */
export function ownTls(
  secrets: readonly SecretRef[],
  certificates: Map<string, TlsCertificate> | undefined
): HostTls {
  const first = secrets[0];
  return {
    at: "own",
    secret: first?.secretName ?? null,
    missing: first ? secretMissing(first, certificates) : false,
  };
}

/** The API server said there is no such Secret, which is not "could not read". */
export const secretMissing = (
  secret: SecretRef,
  certificates: Map<string, TlsCertificate> | undefined
) =>
  certificates?.get(`${secret.namespace}/${secret.secretName}`)?.problem
    ?.says === "noSecret";

export function hostTlsWords(tls: HostTls, t: T): string {
  if (tls.at !== "own") return edgeTlsWords(tls, t);
  if (tls.secret && tls.missing)
    return t("empty", "tlsDefaultCertificate", { name: tls.secret });
  return tls.secret
    ? t("empty", "tlsFrom", { name: tls.secret })
    : t("empty", "tlsControllerCertificate");
}

/**
 * A missing TLS Secret, said as what the client gets: the controller does not
 * refuse the host, it answers with a certificate no browser trusts.
 */
export function missingSecretWords(
  secret: SecretRef,
  controller: { name: string; certificate: string },
  t: T
): { title: string; note: string } {
  return {
    title: t("empty", "tlsSecretMissingTitle", { name: secret.secretName }),
    note: t("empty", "tlsSecretMissingNote", {
      controller: controller.name,
      certificate: controller.certificate,
      secret: `${secret.namespace}/${secret.secretName}`,
    }),
  };
}

/** The word at a host's right end for a certificate finding that is an error. */
export function certificateStateWords(problem: CertificateProblem, t: T) {
  if (problem.read?.problem?.says === "noSecret")
    return t("empty", "certificateMissing");
  return problem.expiry?.expired
    ? t("empty", "certificateExpired")
    : t("empty", "certificateRunningOut");
}

export function hostTlsTag(
  tls: HostTls,
  broken: boolean,
  t: T
): { text: string; tone: "mute" | "warn" | "unknown" | "err" } {
  return tls.at === "own"
    ? { text: "TLS", tone: broken ? "err" : "mute" }
    : edgeTlsTag(tls, t);
}

/** A host row's words for TLS it does not hold itself. */
export function edgeTlsWords(edge: EdgeTls, t: T): string {
  switch (edge.at) {
    case "ingress":
      return t("empty", "tlsEndsAt", { name: edge.name });
    case "edge":
      return t("empty", "tlsEndsAt", { name: t("empty", "theEdge") });
    case "none":
      return t("empty", "noTls");
    case "unknown":
      return t("empty", "tlsNotChecked");
  }
}

/** The routing map's one-word tag for the same. */
export function edgeTlsTag(
  edge: EdgeTls,
  t: T
): { text: string; tone: "mute" | "warn" | "unknown" } {
  switch (edge.at) {
    case "ingress":
    case "edge":
      return { text: "TLS", tone: "mute" };
    case "none":
      return { text: t("empty", "noTls"), tone: "warn" };
    case "unknown":
      return { text: t("empty", "tlsNotChecked"), tone: "unknown" };
  }
}

/**
 * The fronting Ingress that terminates TLS for this host before the proxy
 * sees it — for *this* host, not merely somewhere.
 */
export function terminatedUpstreamOf(
  host: string | null,
  fronting: readonly IngressInfo[]
): { kind: "Ingress"; name: string; namespace: string } | null {
  if (host === null) return null;
  for (const ingress of fronting) {
    const terminates =
      ingress.hasCatchAllTls ||
      covers(ingress.tlsHosts, host) ||
      ingress.tlsConfigs.some((config) => covers(config.hosts, host));
    if (terminates) {
      return {
        kind: "Ingress",
        name: ingress.name,
        namespace: ingress.namespace,
      };
    }
  }
  return null;
}

// --- ordering by trouble ------------------------------------------------

export const SEVERITY_RANK = { err: 2, warn: 1 } as const;

export function worstOf(
  findings: ReadonlyArray<{ severity: "err" | "warn" }>
): "err" | "warn" | null {
  let worst: "err" | "warn" | null = null;
  for (const finding of findings) {
    if (
      worst === null ||
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst]
    ) {
      worst = finding.severity;
    }
  }
  return worst;
}

// --- the certificates a set of routes is served under -------------------

/** A route that may name a TLS Secret in its own namespace. */
interface ServedRoute {
  source: { namespace: string };
  tlsSecret?: string | null;
}

/**
 * The certificates behind the TLS Secrets these routes are served under,
 * keyed `namespace/secret`.
 *
 * Core, and it works on a cluster with nothing installed: `tls.crt` states
 * its own validity. On the key `useTlsCertificates` reads, so an Ingress page
 * and a vendor page ask for one certificate once. Stable until a read
 * changes, so a memo built on it follows a renewed certificate rather than a
 * count of them.
 */
export function useRouteCertificates(
  routes: readonly ServedRoute[] | undefined
): Map<string, TlsCertificate> {
  const batches = useMemo(() => {
    const byNamespace = new Map<string, Set<string>>();
    for (const route of routes ?? []) {
      if (!route.tlsSecret) continue;
      const names = byNamespace.get(route.source.namespace) ?? new Set();
      names.add(route.tlsSecret);
      byNamespace.set(route.source.namespace, names);
    }
    return [...byNamespace].map(([namespace, names]) => ({
      namespace,
      names: [...names].sort(),
    }));
  }, [routes]);

  const combine = useCallback(
    (results: UseQueryResult<Map<string, TlsCertificate>>[]) => {
      const certificates = new Map<string, TlsCertificate>();
      results.forEach((result, index) => {
        const { namespace, names } = batches[index];
        const read = certificatesOf(result.data, result.error, names);
        for (const [name, certificate] of read ?? []) {
          certificates.set(`${namespace}/${name}`, certificate);
        }
      });
      return certificates;
    },
    [batches]
  );

  return useQueries({
    queries: batches.map((batch) => ({
      queryKey: queryKeys.tlsCertificates(batch.namespace, batch.names),
      queryFn: async (): Promise<Map<string, TlsCertificate>> => {
        const read = await commands.getTlsCertificates(
          batch.namespace,
          batch.names
        );
        return new Map(read.map((entry) => [entry.secretName, entry]));
      },
      staleTime: ROUTING_STALE,
    })),
    combine,
  });
}

// --- finding a controller's own workload ----------------------------------

/** A list read for a lookup: its items, or why there are none to look at. */
export interface ListRead<T> {
  items: T[];
  failure: Saying | null;
}

/**
 * Why a lookup list could not be read, naming the cause it had. A deadline
 * filed as "the cluster refused" sends the reader to RBAC for a slow read.
 */
export function lookupFailure(error: unknown): Saying {
  if (isReadDeadline(error)) {
    return {
      key: "controllerLookupDeadline",
      values: { seconds: LIST_DEADLINE_SECONDS },
    };
  }
  const why = errorToShow(error);
  return isRefusal(error)
    ? { key: "controllerUnread", values: { why } }
    : { key: "controllerLookupFailed", values: { why } };
}

/**
 * A list whose failure is kept rather than read as empty. Looking for a
 * controller through `.catch(() => [])` turned a 403 into "no controller is
 * installed", which sends somebody to install one that is running.
 */
export async function listOrFailure<T>(
  read: Promise<T[]>
): Promise<ListRead<T>> {
  try {
    return { items: await read, failure: null };
  } catch (error) {
    return { items: [], failure: lookupFailure(error) };
  }
}

/** Why nothing was found, when nothing could have been: the first failure. */
export function failureOf(...reads: ListRead<unknown>[]): Saying | null {
  if (reads.some((read) => read.items.length > 0)) return null;
  return reads.find((read) => read.failure !== null)?.failure ?? null;
}

/** The workload running a proxy's controller, found by its chart label. */
export interface ControllerWorkload {
  kind: "Deployment" | "DaemonSet";
  name: string;
  namespace: string;
  image: string | null;
  ready: number;
  desired: number;
}

/** A controller's claim, reading its running pods by its label selector. */
export const controllerClients = (
  name: string,
  labelSelector: string
): DoorClaim => ({
  name,
  read: async () => {
    const pods = await commands.listPods({
      namespace: null,
      labelSelector,
      fieldSelector: null,
      limit: null,
      statusFilter: null,
      selector: null,
      nodeName: null,
    });
    return pods
      .filter((pod) => pod.status.phase === "Running" && pod.podIp !== null)
      .map((pod) => ({
        name: pod.name,
        namespace: pod.namespace,
        labels: pod.labels,
        ip: pod.podIp,
        hostNetwork: pod.podIp === pod.hostIp,
      }));
  },
});

/**
 * The controller's workload, whichever kind it runs as, or why none was
 * found. Both charts can install a DaemonSet; reading Deployments alone
 * called a running ingress-nginx DaemonSet "no controller".
 */
export async function findControllerWorkload(
  labelSelector: string
): Promise<{ workload: ControllerWorkload | null; unread: Saying | null }> {
  const filters = {
    namespace: null,
    labelSelector,
    fieldSelector: null,
    limit: null,
  };
  const [deployments, daemonSets] = await Promise.all([
    listOrFailure(commands.listDeployments(filters)),
    listOrFailure(commands.listDaemonsets(filters)),
  ]);
  const deployment = deployments.items[0];
  if (deployment) {
    return {
      workload: {
        kind: "Deployment",
        name: deployment.name,
        namespace: deployment.namespace,
        image: deployment.containers[0]?.image ?? null,
        ready: deployment.replicas.ready,
        desired: deployment.replicas.desired,
      },
      unread: null,
    };
  }
  const daemonSet = daemonSets.items[0];
  if (daemonSet) {
    return {
      workload: {
        kind: "DaemonSet",
        name: daemonSet.name,
        namespace: daemonSet.namespace,
        image: daemonSet.containerImages[0]?.image ?? null,
        ready: daemonSet.ready,
        desired: daemonSet.desired,
      },
      unread: null,
    };
  }
  return { workload: null, unread: failureOf(deployments, daemonSets) };
}

/** The vendor page's routes tab, filtered to one host: a routing map node's way in. */
export const hostFilterLink = (host: string | null): AppLink => ({
  to: ".",
  search: host ? { tab: "routes", q: host } : { tab: "routes" },
});
