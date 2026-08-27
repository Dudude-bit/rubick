/**
 * What every routing page in this tree does the same way.
 *
 * Traefik, ingress-nginx and Istio answer three different questions and
 * three different object models, and underneath all of them sit the same
 * two facts: **an Ingress belongs to the controller whose class claims it**,
 * and **a route is only as healthy as what the Service behind it
 * publishes**. Those were written once for Traefik and are here because
 * there is now a second and a third caller — not because a shared layer was
 * anticipated. A third copy of "does this Service have any ready endpoints"
 * is how two pages start disagreeing about whether the same Service is
 * broken.
 *
 * What is deliberately *not* here is anything that decides what a route
 * means. Traefik's entry points, nginx's annotations and Istio's subsets are
 * each vendor's own, and a helper that tried to hold all three would hold
 * none of them honestly.
 */

import { useQuery } from "@tanstack/react-query";
import { load } from "js-yaml";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { covers, expiryOf, type Expiry } from "@/lib/certificates";
import type {
  ChainStop,
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
 * Matched with {@link covers} rather than by equality, because a wildcard in
 * `spec.tls[].hosts` is the ordinary way to write this: a pair of
 * `*.example.com` and `example.com` on one Secret is what somebody sets up so
 * they never have to think about it again. Compared literally, every
 * subdomain that pair exists to serve came back with no Secret — and the
 * surfaces above this then said the host was served in the clear, which is
 * the app claiming an outage and a security problem that are not there.
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
  /** False while the Services and their slices are still being read. */
  known: boolean;
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
   */
  backingKnown?: boolean;
}

function ref(kind: string, name: string, namespace: string): ObjectRef {
  return { kind, name, namespace, existence: "present", facts: null };
}

function selectorOf(service: ServiceInfo): string {
  return Object.entries(service.selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
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
  const known = sources.backingKnown !== false;
  const empty: Backing = {
    service: undefined,
    ready: 0,
    draining: 0,
    notReady: 0,
    stop: null,
    known,
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

  // An ExternalName Service is a DNS alias with no pods by design, so it has
  // no endpoints and is not a stop. Saying it were would be the page calling
  // a working configuration broken.
  if (service.type === "ExternalName") {
    return { service, ready: 0, draining: 0, notReady: 0, stop: null, known };
  }

  // What the Service publishes, not what its pods look like. The same answer
  // the traffic chain's last hop is built from, so a route reading as broken
  // here reads as broken there, in the same words.
  const published = sources.published.find(
    (candidate) =>
      candidate.service.name === service.name &&
      candidate.service.namespace === service.namespace
  );
  const ready = published?.ready ?? 0;
  const draining = published?.draining ?? 0;
  const notReady = published?.notReady ?? 0;
  const state = { service, ready, draining, notReady, known };

  // A draining address is still the one kube-proxy sends to when nothing
  // ready is left, so a Service down to one is a restart rather than a 502.
  if (ready + draining > 0) return { ...state, stop: null };

  const selector = selectorOf(service);
  // A Service with no selector has its endpoints managed by hand. Whether
  // that is broken is not something these objects say, so nothing is claimed.
  if (selector === "") return { ...state, stop: null };

  const at = ref("Service", service.name, service.namespace);
  const unrouted = published?.unrouted ?? 0;
  // Addresses the endpoint controller wrote into a slice carrying no port at
  // all: it resolved none of the Service's named `targetPort`s, so it wrote
  // the pods down and gave kube-proxy nothing to send to. The pods are Ready
  // and this host answers every request with a 502.
  if (unrouted > 0) {
    return {
      ...state,
      stop: {
        reason: "publishesNothing",
        service: at,
        selector,
        pods: unrouted,
        readyPods: unrouted,
        unnamedPorts: namedTargetPorts(service),
      },
    };
  }
  if (notReady > 0) {
    return {
      ...state,
      stop: { reason: "noneReady", service: at, selector, pods: notReady },
    };
  }
  return {
    ...state,
    stop: { reason: "selectsNothing", service: at, selector },
  };
}

/**
 * The `targetPort`s this Service asks for by name.
 *
 * Only reached where the controller already wrote a portless slice, which is
 * it saying it resolved none of them — so naming them here reports what the
 * cluster did rather than guessing at it. A numeric `targetPort` needs no
 * container to declare anything and can never be the thing that is missing.
 */
function namedTargetPorts(service: ServiceInfo): string[] {
  return service.ports
    .map((port) => port.targetPort)
    .filter((target) => target !== "" && !/^\d+$/.test(target));
}

/** The two lists every routing page needs to say what is behind a route. */
export interface BackingLists {
  services: ServiceInfo[];
  published: ServicePublished[];
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
export function useBackingLists(enabled = true) {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, "routing", "backing"],
    queryFn: async (): Promise<BackingLists> => {
      const [services, published] = await Promise.all([
        commands.listServices(null),
        commands.listServiceEndpoints(null),
      ]);
      return { services, published };
    },
    staleTime: ROUTING_STALE,
    enabled,
  });
}

interface WorkloadManifest {
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{
          args?: unknown[];
          command?: unknown[];
          env?: Array<{ name?: string; value?: string }>;
        }>;
      };
    };
  };
}

/**
 * The flags a controller's process was started with.
 *
 * Both ingress controllers keep something in here that exists nowhere in the
 * API server — Traefik's entry points, nginx's `--configmap` — so both read
 * the workload's own manifest, and neither should have its own idea of where
 * a container's arguments live.
 */
export function workloadArgs(manifest: string): string[] {
  const parsed = load(manifest) as WorkloadManifest | undefined;
  const containers = parsed?.spec?.template?.spec?.containers ?? [];
  return containers.flatMap((container) =>
    [...(container.command ?? []), ...(container.args ?? [])].map(String)
  );
}

/**
 * The container environment those arguments are expanded against.
 *
 * `--configmap=$(POD_NAMESPACE)/ingress-nginx-controller` is what the static
 * manifest actually says, and the kubelet substitutes it at start. Reading
 * the flag without doing the same substitution names a ConfigMap in a
 * namespace called `$(POD_NAMESPACE)`, which does not exist.
 */
export function workloadEnv(manifest: string): Record<string, string> {
  const parsed = load(manifest) as WorkloadManifest | undefined;
  const containers = parsed?.spec?.template?.spec?.containers ?? [];
  const env: Record<string, string> = {};
  for (const container of containers) {
    for (const entry of container.env ?? []) {
      if (entry.name && entry.value !== undefined)
        env[entry.name] = entry.value;
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
  /** `null` where the Secret is there and is not a certificate we could read. */
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
      return [{ ...secret, severity: "warn", read, expiry: null }];
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
