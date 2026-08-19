/**
 * The route's diagnosis, in debug order — the page IS the trace.
 *
 * Eight links, rendered in the order a person who has done this before
 * checks them: class claimed, gateway programmed with an address, listener
 * accepts, namespace allowed, references resolve, backend exists, endpoints
 * ready, reachable from outside. The first broken link is the verdict;
 * everything after it is "not reached", not broken.
 *
 * Two sources of truth, never conflated: what the controllers wrote
 * (conditions, per parent) and what the cluster's objects say for
 * themselves (the gateway list, the Services, what they publish). Where a
 * source cannot be read the step goes dashed — "can't know from here" —
 * instead of guessing either way.
 */

import type {
  BackendRefInfo,
  ConditionInfo,
  GatewayClassInfo,
  GatewayInfo,
  ListenerInfo,
  ParentRefInfo,
  RouteInfo,
  RouteParentStatusInfo,
} from "@/generated/types";
import { backingOf, type Backing, type BackingSources } from "@/integrations";
import { describeStop } from "@/lib/connections";

export interface TraceQuote {
  asks: string;
  serves: string;
}

export interface TraceDetail {
  title: string;
  body: string;
  quote?: TraceQuote;
  /** A ready-to-apply manifest, where one repairs the step. */
  scaffold?: string;
}

export type TraceStepId =
  | "class"
  | "gateway"
  | "listener"
  | "namespace"
  | "refs"
  | "backend"
  | "endpoints"
  | "reachable";

export type TraceStepState = "ok" | "err" | "warn" | "off" | "blind";

export interface TraceStep {
  id: TraceStepId;
  state: TraceStepState;
  say: string;
  who: "infra" | "yours" | "controller" | "machine";
  /** The break compressed to list length — set on every err step, so the
   *  routes list can say "stops at listener — hostnames don't intersect"
   *  in exactly the words this step will expand into. */
  short?: string;
  detail?: TraceDetail;
  /** Set when the verdict is about an older spec generation. */
  freshness?: { observed: number; current: number };
}

export interface RouteTrace {
  /** The parent this trace runs through — named even when missing. */
  gateway: { name: string; namespace: string };
  serving: boolean;
  /** 1-based index of the first broken step, where one is. */
  stopStep: number | null;
  steps: TraceStep[];
  /** What "from this machine" would try: a concrete host, the gateway's
   *  address, the listener's port. Null pieces are simply not probeable. */
  probe: { host: string | null; address: string | null; port: number | null };
}

export interface TraceSources {
  gateways: GatewayInfo[];
  classes: GatewayClassInfo[];
  /** False while gateways and classes are still being read — or cannot be. */
  topologyKnown: boolean;
  backing: BackingSources;
}

const said = (c: ConditionInfo): string =>
  [c.reason, c.message].filter(Boolean).join(" — ") || `${c.type}: ${c.status}`;

/** The staleness trap: a verdict written about an older spec generation. */
function freshnessOf(
  condition: ConditionInfo | undefined,
  route: RouteInfo
): { observed: number; current: number } | undefined {
  if (
    condition?.observedGeneration == null ||
    route.generation == null ||
    condition.observedGeneration >= route.generation
  ) {
    return undefined;
  }
  return { observed: condition.observedGeneration, current: route.generation };
}

function statusesFor(
  route: RouteInfo,
  parent: ParentRefInfo
): RouteParentStatusInfo[] {
  return route.parents.filter(
    (entry) =>
      entry.parent.name === parent.name &&
      (entry.parent.namespace ?? route.namespace) ===
        (parent.namespace ?? route.namespace)
  );
}

/** The listeners this parentRef points at — one by section, or all. */
function candidateListeners(
  gateway: GatewayInfo | undefined,
  parent: ParentRefInfo
): ListenerInfo[] {
  if (!gateway) return [];
  if (parent.sectionName) {
    return gateway.listeners.filter((l) => l.name === parent.sectionName);
  }
  if (parent.port != null) {
    return gateway.listeners.filter((l) => l.port === parent.port);
  }
  return gateway.listeners;
}

function classStep(
  gateway: GatewayInfo | undefined,
  classes: GatewayClassInfo[],
  topologyKnown: boolean
): TraceStep {
  if (!topologyKnown) {
    return {
      id: "class",
      state: "blind",
      say: "GatewayClass — cannot be read from here",
      who: "infra",
    };
  }
  if (!gateway) {
    return {
      id: "class",
      state: "blind",
      say: "GatewayClass — unknown, the Gateway itself is missing",
      who: "infra",
    };
  }
  const cls = classes.find((c) => c.name === gateway.className);
  if (!cls) {
    return {
      id: "class",
      state: "err",
      say: `Class ${gateway.className} does not exist`,
      who: "infra",
      short: `class ${gateway.className} does not exist`,
      detail: {
        title: `No GatewayClass named ${gateway.className}`,
        body: "The Gateway names a class that is not installed. No controller will ever program it — everything through this gateway is dead until the class exists or the Gateway names one that does.",
      },
    };
  }
  if (cls.accepted !== true) {
    const refused = cls.conditions.find(
      (c) => c.type === "Accepted" && c.status === "False"
    );
    return {
      id: "class",
      state: "err",
      say: `Nothing claims class ${gateway.className}`,
      who: "infra",
      short: `nothing claims class ${gateway.className}`,
      detail: {
        title: `No controller has accepted ${gateway.className}`,
        body: refused
          ? `${said(refused)}. Everything through this gateway is dead until a controller claims the class.`
          : `The class names controller ${cls.controllerName}, and nothing has answered for it. Usually the controller is not installed or not running — everything through this gateway is dead until it does.`,
      },
    };
  }
  return {
    id: "class",
    state: "ok",
    say: `Class ${gateway.className} is claimed by ${cls.controllerName}`,
    who: "infra",
  };
}

function gatewayStep(
  gateway: GatewayInfo | undefined,
  parent: ParentRefInfo,
  routeNamespace: string,
  topologyKnown: boolean
): TraceStep {
  const at = parent.namespace ?? routeNamespace;
  if (!topologyKnown) {
    return {
      id: "gateway",
      state: "blind",
      say: `Gateway ${parent.name} — cannot be read from here`,
      who: "infra",
    };
  }
  if (!gateway) {
    return {
      id: "gateway",
      state: "err",
      say: `Gateway ${parent.name} does not exist in ${at}`,
      who: "yours",
      short: `${parent.name} does not exist`,
      detail: {
        title: "The parentRef names a Gateway that is not there",
        body: "Nothing can accept this route. Usually a typo in the name or namespace, or the Gateway was deleted after the route was written.",
      },
    };
  }
  const programmed =
    gateway.conditions.find((c) => c.type === "Programmed") ??
    gateway.conditions.find((c) => c.type === "Ready");
  if (programmed?.status === "False") {
    return {
      id: "gateway",
      state: "err",
      say: `Gateway ${gateway.name} is not programmed`,
      who: "infra",
      short: `${gateway.name} is not programmed`,
      detail: {
        title: "The controller refuses this Gateway",
        body: `${said(programmed)}. Nothing behind it serves until the Gateway itself is fixed — this is upstream of every route attached to it.`,
      },
    };
  }
  if (gateway.addresses.length === 0) {
    return {
      id: "gateway",
      state: "err",
      say: `Gateway ${gateway.name} has no address yet`,
      who: "infra",
      short: `${gateway.name} has no address yet`,
      detail: {
        title: "No address to send traffic to",
        body: "The controller accepted the Gateway but no address has been assigned — on cloud LoadBalancers this is provisioning still running, a quota hit, or the implementation failing to allocate. Until an address exists, traffic has nowhere to arrive.",
      },
    };
  }
  if (!programmed) {
    return {
      id: "gateway",
      state: "warn",
      say: `Gateway ${gateway.name} — the controller has not reported Programmed`,
      who: "infra",
    };
  }
  return {
    id: "gateway",
    state: "ok",
    say: `Gateway ${gateway.name} is programmed · ${gateway.addresses.join(", ")}`,
    who: "infra",
  };
}

function listenerLabel(listeners: ListenerInfo[]): string {
  if (listeners.length === 1) return `Listener :${listeners[0].name}`;
  return "A listener";
}

function servesOf(listeners: ListenerInfo[]): string {
  if (listeners.length === 0) return "unknown — the listener was not found";
  return listeners.map((l) => l.hostname ?? "all hosts").join(", ");
}

/** Steps 3 and 4 — both written by the controller as one Accepted verdict,
 *  split here so the break lands on the link the reason actually names. */
function acceptanceSteps(
  route: RouteInfo,
  gateway: GatewayInfo | undefined,
  parent: ParentRefInfo,
  entries: RouteParentStatusInfo[]
): [TraceStep, TraceStep] {
  const listeners = candidateListeners(gateway, parent);
  const label = listenerLabel(listeners);

  if (entries.length === 0) {
    return [
      {
        id: "listener",
        state: "err",
        say: "No controller answered for this parent",
        who: "controller",
        short: "no controller answered",
        detail: {
          title: "No status was written for this route",
          body: "No controller wrote a verdict for this parent. Either nothing claims the Gateway's class, or the controller is not running — the route is invisible to the data plane either way.",
        },
      },
      namespaceQuiet(route, listeners, "off"),
    ];
  }

  const accepted = entries
    .flatMap((entry) => entry.conditions)
    .find((c) => c.type === "Accepted");
  const freshness = freshnessOf(accepted, route);

  if (!accepted) {
    return [
      {
        id: "listener",
        state: "warn",
        say: "The controller wrote status but no Accepted verdict yet",
        who: "controller",
        freshness,
      },
      namespaceQuiet(route, listeners, "ok"),
    ];
  }

  if (accepted.status === "False") {
    if (accepted.reason === "NotAllowedByListeners") {
      return [
        {
          id: "listener",
          state: "ok",
          say: `${label} matches this route`,
          who: "yours",
          freshness,
        },
        {
          id: "namespace",
          state: "err",
          say: `The listener does not allow routes from ${route.namespace}`,
          who: "yours",
          short: `namespace ${route.namespace} not allowed`,
          freshness,
          detail: {
            title: "The namespace is outside what the listener allows",
            body: `${said(accepted)}. The listener's allowedRoutes decide which namespaces may attach — widen them on the Gateway, or move the route.`,
            quote: {
              asks: route.namespace,
              serves: listeners
                .map((l) => l.allowedNamespaces ?? "Same")
                .join(", "),
            },
          },
        },
      ];
    }
    const hostnameMiss = accepted.reason === "NoMatchingListenerHostname";
    return [
      {
        id: "listener",
        state: "err",
        say: `${label} does not accept this route`,
        who: "yours",
        short: hostnameMiss
          ? "hostnames don't intersect"
          : (accepted.reason ?? "refused"),
        freshness,
        detail: {
          title: hostnameMiss
            ? "Hostnames don't intersect"
            : "The gateway does not accept this route",
          body: `${said(accepted)}. An unaccepted route is never programmed — the YAML is valid, and nothing serves it.`,
          quote: hostnameMiss
            ? {
                asks: route.hostnames.join(", ") || "any host",
                serves: servesOf(listeners),
              }
            : undefined,
        },
      },
      namespaceQuiet(route, listeners, "off"),
    ];
  }

  return [
    {
      id: "listener",
      state: freshness ? "warn" : "ok",
      say: `${label} accepts this route`,
      who: "yours",
      freshness,
      detail: freshness
        ? {
            title: "This verdict is about the previous version of the route",
            body: `The controller last looked at generation ${freshness.observed}; you are on ${freshness.current}. Everything below may change when it catches up — usually seconds. Nothing here is wrong yet; it is old.`,
          }
        : undefined,
    },
    namespaceQuiet(route, listeners, "ok"),
  ];
}

function namespaceQuiet(
  route: RouteInfo,
  listeners: ListenerInfo[],
  state: "ok" | "off"
): TraceStep {
  const allowed = listeners.map((l) => l.allowedNamespaces ?? "Same");
  return {
    id: "namespace",
    state,
    say:
      state === "ok"
        ? `Namespace ${route.namespace} is allowed by the listener${
            allowed.length > 0 ? ` (${allowed.join(", ")})` : ""
          }`
        : "Namespace allowed by the listener",
    who: "yours",
  };
}

/** The manifest that repairs RefNotPermitted, scoped to exactly this
 *  from/to pair — implementations differ per kind, a broad one may not do. */
function grantScaffold(route: RouteInfo, targetNamespace: string): string {
  return [
    "apiVersion: gateway.networking.k8s.io/v1beta1",
    "kind: ReferenceGrant",
    "metadata:",
    `  name: allow-${route.namespace}-${route.kind.toLowerCase()}s`,
    `  namespace: ${targetNamespace}`,
    "spec:",
    "  from:",
    "    - group: gateway.networking.k8s.io",
    `      kind: ${route.kind}`,
    `      namespace: ${route.namespace}`,
    "  to:",
    '    - group: ""',
    "      kind: Service",
  ].join("\n");
}

function refsStep(
  route: RouteInfo,
  entries: RouteParentStatusInfo[]
): TraceStep {
  const resolved = entries
    .flatMap((entry) => entry.conditions)
    .find((c) => c.type === "ResolvedRefs");
  const freshness = freshnessOf(resolved, route);

  if (resolved?.status === "False") {
    if (resolved.reason === "RefNotPermitted") {
      const foreign = route.rules
        .flatMap((rule) => rule.backendRefs)
        .find(
          (backend) =>
            backend.namespace != null && backend.namespace !== route.namespace
        );
      const target = foreign?.namespace ?? "<target-namespace>";
      return {
        id: "refs",
        state: "err",
        say: foreign
          ? `Reference to ${target}/${foreign.name} is not permitted`
          : "A reference is not permitted",
        who: "yours",
        short: `needs a ReferenceGrant in ${target}`,
        freshness,
        detail: {
          title: `No ReferenceGrant in ${target} allows it`,
          body: `${said(resolved)}. A cross-namespace reference needs the target namespace's consent, and the controller must fail this traffic until it exists. This exact grant would fix it:`,
          scaffold: grantScaffold(route, target),
        },
      };
    }
    return {
      id: "refs",
      state: "err",
      say: "A reference this route makes did not resolve",
      who: "yours",
      short:
        resolved.message ?? resolved.reason ?? "a reference did not resolve",
      freshness,
      detail: {
        title: "ResolvedRefs: False",
        body: `${said(resolved)}.`,
      },
    };
  }

  return {
    id: "refs",
    state: freshness ? "warn" : "ok",
    say:
      resolved == null
        ? "References resolve — nothing reported otherwise"
        : "References resolve",
    who: "yours",
    freshness,
  };
}

interface BackendVerdict {
  backend: BackendRefInfo;
  namespace: string;
  state: Backing;
}

/** Steps 6 and 7 — what the backends' Services say for themselves. */
function backendSteps(
  route: RouteInfo,
  backing: BackingSources
): [TraceStep, TraceStep] {
  const serviceRefs = route.rules.flatMap((rule) =>
    rule.backendRefs.filter((backend) => backend.kind === "Service")
  );
  const redirectOnly =
    serviceRefs.length === 0 &&
    route.rules.length > 0 &&
    route.rules.every((rule) => rule.hasRedirect);

  if (redirectOnly) {
    const say = "This route redirects — no backends, and none needed";
    return [
      { id: "backend", state: "ok", say, who: "yours" },
      { id: "endpoints", state: "ok", say, who: "yours" },
    ];
  }
  if (serviceRefs.length === 0) {
    return [
      {
        id: "backend",
        state: "err",
        say: "No backendRefs — a matched request has nowhere to go",
        who: "yours",
        short: "no backendRefs — matched requests have nowhere to go",
        detail: {
          title: "The route matches traffic and drops it",
          body: "Every rule is missing backendRefs (and does not redirect). A matched request gets an immediate error from the gateway.",
        },
      },
      {
        id: "endpoints",
        state: "off",
        say: "Endpoints published and ready",
        who: "yours",
      },
    ];
  }
  if (backing.backingKnown === false) {
    return [
      {
        id: "backend",
        state: "blind",
        say: "Backend Services — still being read",
        who: "yours",
      },
      {
        id: "endpoints",
        state: "blind",
        say: "Endpoints — still being read",
        who: "yours",
      },
    ];
  }

  const verdicts: BackendVerdict[] = serviceRefs.map((backend) => ({
    backend,
    namespace: backend.namespace ?? route.namespace,
    state: backingOf(
      { name: backend.name, namespace: backend.namespace ?? route.namespace },
      { kind: route.kind, name: route.name, namespace: route.namespace },
      backing
    ),
  }));

  const missing = verdicts.find(
    (v) => v.state.stop?.reason === "backendMissing"
  );
  const wrongPort = verdicts.find(
    (v) =>
      v.state.service != null &&
      v.backend.port != null &&
      !v.state.service.ports.some((p) => p.port === v.backend.port)
  );

  const backendStep: TraceStep = missing
    ? {
        id: "backend",
        state: "err",
        say: `Backend Service ${missing.backend.name} does not exist in ${missing.namespace}`,
        who: "yours",
        short: `Service ${missing.backend.name} does not exist`,
        detail: {
          title: describeStop(missing.state.stop!).title,
          body: describeStop(missing.state.stop!).note,
        },
      }
    : wrongPort
      ? {
          id: "backend",
          state: "err",
          say: `Service ${wrongPort.backend.name} does not serve port ${wrongPort.backend.port}`,
          who: "yours",
          short: `Service ${wrongPort.backend.name} does not serve port ${wrongPort.backend.port}`,
          detail: {
            title: "The Service exists, the port does not",
            body: "The backendRef's port must be one of the Service's own ports — traffic to any other number is refused before it reaches a pod.",
            quote: {
              asks: String(wrongPort.backend.port),
              serves:
                wrongPort.state
                  .service!.ports.map((p) => String(p.port))
                  .join(", ") || "no ports at all",
            },
          },
        }
      : {
          id: "backend",
          state: "ok",
          say:
            verdicts.length === 1
              ? `Backend Service ${verdicts[0].backend.name} serves :${verdicts[0].backend.port ?? "?"}`
              : `All ${verdicts.length} backend Services exist, ports match`,
          who: "yours",
        };

  if (backendStep.state === "err") {
    return [
      backendStep,
      {
        id: "endpoints",
        state: "off",
        say: "Endpoints published and ready",
        who: "yours",
      },
    ];
  }

  const down = verdicts.find(
    (v) => v.state.stop != null && v.state.stop.reason !== "backendMissing"
  );
  if (down) {
    const stop = describeStop(down.state.stop!);
    return [
      backendStep,
      {
        id: "endpoints",
        state: "err",
        say: `${down.backend.name}: ${stop.title}`,
        who: "yours",
        short: stop.title,
        detail: { title: stop.title, body: stop.note },
      },
    ];
  }

  const external = verdicts.every(
    (v) => v.state.service?.type === "ExternalName"
  );
  const ready = verdicts.reduce((sum, v) => sum + v.state.ready, 0);
  const draining = verdicts.reduce((sum, v) => sum + v.state.draining, 0);
  return [
    backendStep,
    {
      id: "endpoints",
      state: "ok",
      say: external
        ? "Resolves elsewhere (ExternalName) — no endpoints by design"
        : `Endpoints publish ${ready} ready${draining > 0 ? `, ${draining} draining` : ""}`,
      who: "yours",
    },
  ];
}

function probeOf(
  route: RouteInfo,
  gateway: GatewayInfo | undefined,
  parent: ParentRefInfo
): RouteTrace["probe"] {
  // A wildcard never resolves; probe the first concrete name.
  const host = route.hostnames.find((name) => !name.startsWith("*")) ?? null;
  const listeners = candidateListeners(gateway, parent);
  return {
    host,
    address: gateway?.addresses[0] ?? null,
    port: listeners[0]?.port ?? parent.port ?? null,
  };
}

function reachableStep(probe: RouteTrace["probe"]): TraceStep {
  if (probe.host == null && probe.address == null) {
    return {
      id: "reachable",
      state: "off",
      say: "Reachable from outside — nothing to probe",
      who: "machine",
    };
  }
  return {
    id: "reachable",
    state: "blind",
    say: "Reachable from outside — DNS · TCP · not checked yet",
    who: "machine",
  };
}

function traceFor(
  route: RouteInfo,
  parent: ParentRefInfo,
  sources: TraceSources
): RouteTrace {
  const namespace = parent.namespace ?? route.namespace;
  const gateway = sources.gateways.find(
    (g) => g.name === parent.name && g.namespace === namespace
  );
  const entries = statusesFor(route, parent);
  const [listener, allowed] = acceptanceSteps(route, gateway, parent, entries);
  const [backend, endpoints] = backendSteps(route, sources.backing);
  const probe = probeOf(route, gateway, parent);

  const steps: TraceStep[] = [
    classStep(gateway, sources.classes, sources.topologyKnown),
    gatewayStep(gateway, parent, route.namespace, sources.topologyKnown),
    listener,
    allowed,
    refsStep(route, entries),
    backend,
    endpoints,
    reachableStep(probe),
  ];

  const firstBroken = steps.findIndex((step) => step.state === "err");
  if (firstBroken >= 0) {
    for (const step of steps.slice(firstBroken + 1)) {
      step.state = "off";
      step.detail = undefined;
      step.freshness = undefined;
    }
  }

  return {
    gateway: { name: parent.name, namespace },
    serving: firstBroken < 0,
    stopStep: firstBroken < 0 ? null : firstBroken + 1,
    steps,
    probe,
  };
}

/**
 * One trace per Gateway parent. Mesh parents (GAMMA — parentRef to a
 * Service) are not this page's to judge and produce no trace; a route with
 * only mesh parents returns none, and the page says so in its own words.
 */
export function routeTraces(
  route: RouteInfo,
  sources: TraceSources
): RouteTrace[] {
  return route.parentRefs
    .filter((parent) => parent.kind === "Gateway")
    .map((parent) => traceFor(route, parent, sources));
}
