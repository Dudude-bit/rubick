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
import type { T } from "@/i18n/useT";

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
  /** Addresses this step vouches for, kept out of {@link say} so the UI
   *  can make each one copyable instead of baking them into prose. */
  addresses?: string[];
  /** The object {@link say} names, where it exists — so the UI can make
   *  the name a peek like every other reference in the app. Absent on a
   *  missing object: a link to a 404 is worse than plain text. */
  subject?: {
    kind: string;
    name: string;
    namespace: string | null;
  };
  /** A Service port worth forwarding, kept out of {@link say} so the UI
   *  can make it a click-to-forward instead of baking it into prose.
   *  Only set beside a Service {@link subject} that answers on it. */
  forwardPort?: number;
  detail?: TraceDetail;
  /** Set when the verdict is about an older spec generation. */
  freshness?: { observed: number; current: number };
}

export interface RouteTrace {
  /** The parent this trace runs through — named even when missing. The
   *  sectionName keeps two attachments to one gateway distinct. */
  gateway: { name: string; namespace: string; sectionName: string | null };
  serving: boolean;
  /**
   * False when a step could not read its source.
   *
   * `serving` is computed from the steps that broke, and a step that could
   * not look is not a step that found nothing — a reader without cluster-wide
   * Gateway rights would otherwise get a green verdict on a route nobody
   * verified. A refusal still counts as known: an `err` is an answer. So does
   * the unprobed last mile, which is blind on every healthy trace.
   */
  servingKnown: boolean;
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

/** The Programmed verdict, with the legacy `Ready` fallback some
 *  controllers still write — one rule, so the trace, the pulse and the
 *  topology map can never drift apart on it again. */
export function gatewayProgrammed(
  gateway: GatewayInfo
): ConditionInfo | undefined {
  return (
    gateway.conditions.find((c) => c.type === "Programmed") ??
    gateway.conditions.find((c) => c.type === "Ready")
  );
}

/** One lookup for "this name+namespace, in the fetched list". */
export function findGateway(
  gateways: GatewayInfo[],
  name: string,
  namespace: string
): GatewayInfo | undefined {
  return gateways.find(
    (candidate) => candidate.name === name && candidate.namespace === namespace
  );
}

/** The protocol label a hostless route kind wears wherever it is drawn. */
export const HOSTLESS_PROTO: Record<string, string> = {
  TCPRoute: "TCP",
  UDPRoute: "UDP",
  TLSRoute: "TLS",
};

const namesNoService = (route: RouteInfo): boolean =>
  !route.rules.some((rule) =>
    rule.backendRefs.some((backend) => backend.kind === "Service")
  );

/** Redirect-only means every rule redirects and none names a Service —
 *  configuration, not breakage, in the same words on every surface. */
export function redirectOnly(route: RouteInfo): boolean {
  return (
    route.rules.length > 0 &&
    route.rules.every((rule) => rule.hasRedirect) &&
    namesNoService(route)
  );
}

const namesNoBackend = (route: RouteInfo): boolean =>
  !route.rules.some((rule) => rule.backendRefs.length > 0);

/**
 * Every rule either redirects or hands off to an ExtensionRef filter, and
 * the route names no backend at all.
 *
 * **This is not a claim that the filter answers.** What a vendor filter does
 * is its vendor's business and this app does not read it: `KongPlugin` and
 * Traefik's `Middleware` are ExtensionRefs that decorate a request and still
 * need somewhere to send it, and even Envoy Gateway's own `HTTPRouteFilter`
 * has variants that do. All this says is that there is nothing here for the
 * backend steps to look at — which is why they go `blind` rather than `ok`,
 * and why the copy names the filter instead of vouching for it.
 *
 * `namesNoBackend`, not `namesNoService`: a route with a non-Service
 * backendRef does name somewhere to go, and saying "no backends" about it
 * would be false.
 */
export function selfAnswered(route: RouteInfo): boolean {
  return (
    route.rules.length > 0 &&
    route.rules.every(
      (rule) => rule.hasRedirect || rule.extensionRefs.length > 0
    ) &&
    namesNoBackend(route)
  );
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
  const named = route.parents.filter(
    (entry) =>
      entry.parent.name === parent.name &&
      (entry.parent.namespace ?? route.namespace) ===
        (parent.namespace ?? route.namespace)
  );
  // A status parentRef echoes the spec's, sectionName included — a route
  // attached to one gateway through two listeners has two verdicts, and
  // each trace must read its own. Entries that name no section (or a
  // controller that did not echo it) fall back for every attachment.
  const exact = named.filter(
    (entry) =>
      (entry.parent.sectionName ?? null) === (parent.sectionName ?? null)
  );
  return exact.length > 0 ? exact : named;
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
  topologyKnown: boolean,
  t: T
): TraceStep {
  if (!topologyKnown) {
    return {
      id: "class",
      state: "blind",
      say: t("empty", "gwClassBlind"),
      who: "infra",
    };
  }
  if (!gateway) {
    return {
      id: "class",
      state: "blind",
      say: t("empty", "gwClassNoGateway"),
      who: "infra",
    };
  }
  const subject = {
    kind: "GatewayClass",
    name: gateway.className,
    namespace: null,
  };
  const cls = classes.find((c) => c.name === gateway.className);
  if (!cls) {
    return {
      id: "class",
      state: "err",
      say: t("empty", "gwClassMissingSay", { name: gateway.className }),
      who: "infra",
      short: t("empty", "gwClassMissingShort", { name: gateway.className }),
      detail: {
        title: t("empty", "gwClassMissingTitle", { name: gateway.className }),
        body: t("empty", "gwClassMissingBody"),
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
      say: t("empty", "gwClassUnclaimedSay", { name: gateway.className }),
      who: "infra",
      short: t("empty", "gwClassUnclaimedShort", { name: gateway.className }),
      subject,
      detail: {
        title: t("empty", "gwClassUnclaimedTitle", { name: gateway.className }),
        body: refused
          ? t("empty", "gwClassRefusedBody", { said: said(refused) })
          : t("empty", "gwClassSilentBody", {
              controller: cls.controllerName,
            }),
      },
    };
  }
  return {
    id: "class",
    state: "ok",
    say: t("empty", "gwClassClaimedSay", {
      name: gateway.className,
      controller: cls.controllerName,
    }),
    who: "infra",
    subject,
  };
}

function gatewayStep(
  gateway: GatewayInfo | undefined,
  parent: ParentRefInfo,
  routeNamespace: string,
  topologyKnown: boolean,
  t: T
): TraceStep {
  const at = parent.namespace ?? routeNamespace;
  if (!topologyKnown) {
    return {
      id: "gateway",
      state: "blind",
      say: t("empty", "gwGatewayBlind", { name: parent.name }),
      who: "infra",
    };
  }
  if (!gateway) {
    return {
      id: "gateway",
      state: "err",
      say: t("empty", "gwGatewayMissingSay", {
        name: parent.name,
        namespace: at,
      }),
      who: "yours",
      short: t("empty", "gwGatewayMissingShort", { name: parent.name }),
      detail: {
        title: t("empty", "gwGatewayMissingTitle"),
        body: t("empty", "gwGatewayMissingBody"),
      },
    };
  }
  const subject = {
    kind: "Gateway",
    name: gateway.name,
    namespace: gateway.namespace,
  };
  const programmed = gatewayProgrammed(gateway);
  if (programmed?.status === "False") {
    return {
      id: "gateway",
      state: "err",
      say: t("empty", "gwNotProgrammedSay", { name: gateway.name }),
      who: "infra",
      short: t("empty", "gwNotProgrammedShort", { name: gateway.name }),
      subject,
      detail: {
        title: t("empty", "gwNotProgrammedTitle"),
        body: t("empty", "gwNotProgrammedBody", { said: said(programmed) }),
      },
    };
  }
  if (gateway.addresses.length === 0) {
    return {
      id: "gateway",
      state: "err",
      say: t("empty", "gwNoAddressSay", { name: gateway.name }),
      who: "infra",
      short: t("empty", "gwNoAddressShort", { name: gateway.name }),
      subject,
      detail: {
        title: t("empty", "gwNoAddressTitle"),
        body: t("empty", "gwNoAddressBody"),
      },
    };
  }
  if (!programmed) {
    return {
      id: "gateway",
      state: "warn",
      say: t("empty", "gwProgrammedQuietSay", { name: gateway.name }),
      who: "infra",
      subject,
    };
  }
  return {
    id: "gateway",
    state: "ok",
    say: t("empty", "gwProgrammedSay", { name: gateway.name }),
    who: "infra",
    addresses: gateway.addresses,
    subject,
  };
}

function listenerLabel(listeners: ListenerInfo[], t: T): string {
  if (listeners.length === 1) {
    return t("empty", "gwListenerNamed", { name: listeners[0].name });
  }
  return t("empty", "gwListenerAny");
}

/** The hostnames a listener set serves, for the two sides of a mismatch
 *  quote. Named for the listener, like `listenerLabel` beside it: the routes
 *  list has a helper of its own by the old name, about a route rather than a
 *  listener, and one word for two ideas across two files of one feature is a
 *  trap for whoever reads them in either order. */
function listenerHosts(listeners: ListenerInfo[], t: T): string {
  if (listeners.length === 0) return t("empty", "gwListenerNotFound");
  return listeners
    .map((l) => l.hostname ?? t("empty", "gwAllHosts"))
    .join(", ");
}

/** Steps 3 and 4 — both written by the controller as one Accepted verdict,
 *  split here so the break lands on the link the reason actually names. */
function acceptanceSteps(
  route: RouteInfo,
  gateway: GatewayInfo | undefined,
  parent: ParentRefInfo,
  entries: RouteParentStatusInfo[],
  t: T
): [TraceStep, TraceStep] {
  const listeners = candidateListeners(gateway, parent);
  const label = listenerLabel(listeners, t);

  if (entries.length === 0) {
    return [
      {
        id: "listener",
        state: "err",
        say: t("empty", "gwNoControllerForParentSay"),
        who: "controller",
        short: t("empty", "gwNoControllerShort"),
        detail: {
          title: t("empty", "gwNoStatusTitle"),
          body: t("empty", "gwNoStatusBody"),
        },
      },
      namespaceQuiet(route, listeners, "off", t),
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
        say: t("empty", "gwNoAcceptedYet"),
        who: "controller",
        freshness,
      },
      namespaceQuiet(route, listeners, "ok", t),
    ];
  }

  if (accepted.status === "False") {
    if (accepted.reason === "NotAllowedByListeners") {
      return [
        {
          id: "listener",
          state: "ok",
          say: t("empty", "gwListenerMatches", { label }),
          who: "yours",
          freshness,
        },
        {
          id: "namespace",
          state: "err",
          say: t("empty", "gwNsNotAllowedSay", {
            namespace: route.namespace,
          }),
          who: "yours",
          short: t("empty", "gwNsNotAllowedShort", {
            namespace: route.namespace,
          }),
          // The namespace's labels are the fix — a selector matches them.
          subject: {
            kind: "Namespace",
            name: route.namespace,
            namespace: null,
          },
          freshness,
          detail: {
            title: t("empty", "gwNsNotAllowedTitle"),
            body: t("empty", "gwNsNotAllowedBody", { said: said(accepted) }),
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
        say: t("empty", "gwListenerRefusesSay", { label }),
        who: "yours",
        short: hostnameMiss
          ? t("empty", "gwHostnamesShort")
          : (accepted.reason ?? t("empty", "gwRefusedWord")),
        freshness,
        detail: {
          title: hostnameMiss
            ? t("empty", "gwHostnamesTitle")
            : t("empty", "gwRouteRefusedTitle"),
          body: t("empty", "gwRouteRefusedBody", { said: said(accepted) }),
          quote: hostnameMiss
            ? {
                asks: route.hostnames.join(", ") || t("empty", "anyHost"),
                serves: listenerHosts(listeners, t),
              }
            : undefined,
        },
      },
      namespaceQuiet(route, listeners, "off", t),
    ];
  }

  return [
    {
      id: "listener",
      state: freshness ? "warn" : "ok",
      say: t("empty", "gwListenerAccepts", { label }),
      who: "yours",
      freshness,
      detail: freshness
        ? {
            title: t("empty", "gwStaleTitle"),
            body: t("empty", "gwStaleBody", {
              observed: freshness.observed,
              current: freshness.current,
            }),
          }
        : undefined,
    },
    namespaceQuiet(route, listeners, "ok", t),
  ];
}

function namespaceQuiet(
  route: RouteInfo,
  listeners: ListenerInfo[],
  state: "ok" | "off",
  t: T
): TraceStep {
  const allowed = listeners.map((l) => l.allowedNamespaces ?? "Same");
  return {
    id: "namespace",
    state,
    say:
      state === "ok"
        ? allowed.length > 0
          ? t("empty", "gwNsAllowedListSay", {
              namespace: route.namespace,
              list: allowed.join(", "),
            })
          : t("empty", "gwNsAllowedSay", { namespace: route.namespace })
        : t("empty", "gwNsAllowedQuiet"),
    who: "yours",
    subject:
      state === "ok"
        ? { kind: "Namespace", name: route.namespace, namespace: null }
        : undefined,
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
  entries: RouteParentStatusInfo[],
  t: T
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
          ? t("empty", "gwRefNotPermittedSay", {
              target: `${target}/${foreign.name}`,
            })
          : t("empty", "gwRefNotPermittedAnon"),
        who: "yours",
        short: t("empty", "gwRefNotPermittedShort", { namespace: target }),
        // The backend may well exist — only the *permission* is missing —
        // so its name stays a reference the reader can peek behind.
        subject: foreign
          ? { kind: "Service", name: foreign.name, namespace: target }
          : undefined,
        freshness,
        detail: {
          title: t("empty", "gwRefNotPermittedTitle", { namespace: target }),
          body: t("empty", "gwRefNotPermittedBody", { said: said(resolved) }),
          scaffold: grantScaffold(route, target),
        },
      };
    }
    return {
      id: "refs",
      state: "err",
      say: t("empty", "gwRefUnresolvedSay"),
      who: "yours",
      short:
        resolved.message ??
        resolved.reason ??
        t("empty", "gwRefUnresolvedShort"),
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
        ? t("empty", "gwRefsResolveQuiet")
        : t("empty", "gwRefsResolve"),
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
  backing: BackingSources,
  t: T
): [TraceStep, TraceStep] {
  const serviceRefs = route.rules.flatMap((rule) =>
    rule.backendRefs.filter((backend) => backend.kind === "Service")
  );
  // A redirect is terminal by the spec's own words, so this app can say it
  // needs no backend and mean it.
  if (serviceRefs.length === 0 && redirectOnly(route)) {
    const say = t("empty", "gwRedirectsOnly");
    return [
      { id: "backend", state: "ok", say, who: "yours" },
      { id: "endpoints", state: "ok", say, who: "yours" },
    ];
  }
  // A filter is named and nothing else is. Blind, not ok: the difference
  // between "we looked and it is fine" and "there is nothing here we can
  // read". It is also what keeps `servingKnown` false, so a route nobody
  // verified does not come back reading verified — which is what this
  // branch did when it answered `ok`, and how a Kong plugin with a
  // forgotten backendRef would have read as serving.
  if (serviceRefs.length === 0 && selfAnswered(route)) {
    const say = t("empty", "gwFilterNamed");
    return [
      { id: "backend", state: "blind", say, who: "yours" },
      { id: "endpoints", state: "blind", say, who: "yours" },
    ];
  }
  if (serviceRefs.length === 0) {
    return [
      {
        id: "backend",
        state: "err",
        say: t("empty", "gwNoBackendRefsSay"),
        who: "yours",
        short: t("empty", "gwNoBackendRefsShort"),
        detail: {
          title: t("empty", "gwNoBackendRefsTitle"),
          body: t("empty", "gwNoBackendRefsBody"),
        },
      },
      {
        id: "endpoints",
        state: "off",
        say: t("empty", "gwEndpointsQuiet"),
        who: "yours",
      },
    ];
  }
  if (backing.backingKnown === false) {
    return [
      {
        id: "backend",
        state: "blind",
        say: t("empty", "gwBackendsReading"),
        who: "yours",
      },
      {
        id: "endpoints",
        state: "blind",
        say: t("empty", "gwEndpointsReading"),
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
        say: t("empty", "gwBackendMissingSay", {
          name: missing.backend.name,
          namespace: missing.namespace,
        }),
        who: "yours",
        short: t("empty", "gwBackendMissingShort", {
          name: missing.backend.name,
        }),
        detail: {
          title: describeStop(missing.state.stop!, t).title,
          body: describeStop(missing.state.stop!, t).note,
        },
      }
    : wrongPort
      ? {
          id: "backend",
          state: "err",
          say: t("empty", "gwWrongPortSay", {
            name: wrongPort.backend.name,
            port: wrongPort.backend.port!,
          }),
          who: "yours",
          short: t("empty", "gwWrongPortSay", {
            name: wrongPort.backend.name,
            port: wrongPort.backend.port!,
          }),
          subject: {
            kind: "Service",
            name: wrongPort.backend.name,
            namespace: wrongPort.namespace,
          },
          detail: {
            title: t("empty", "gwWrongPortTitle"),
            body: t("empty", "gwWrongPortBody"),
            quote: {
              asks: String(wrongPort.backend.port),
              serves:
                wrongPort.state
                  .service!.ports.map((p) => String(p.port))
                  .join(", ") || t("empty", "gwNoPortsAtAll"),
            },
          },
        }
      : {
          id: "backend",
          state: "ok",
          say:
            verdicts.length === 1
              ? verdicts[0].backend.port != null
                ? t("empty", "gwBackendServes", {
                    name: verdicts[0].backend.name,
                  })
                : t("empty", "gwBackendExists", {
                    name: verdicts[0].backend.name,
                  })
              : t("count", "gwBackendsAllExist", { n: verdicts.length }),
          who: "yours",
          subject:
            verdicts.length === 1
              ? {
                  kind: "Service",
                  name: verdicts[0].backend.name,
                  namespace: verdicts[0].namespace,
                }
              : undefined,
          forwardPort:
            verdicts.length === 1
              ? (verdicts[0].backend.port ?? undefined)
              : undefined,
        };

  if (backendStep.state === "err") {
    return [
      backendStep,
      {
        id: "endpoints",
        state: "off",
        say: t("empty", "gwEndpointsQuiet"),
        who: "yours",
      },
    ];
  }

  const down = verdicts.find(
    (v) => v.state.stop != null && v.state.stop.reason !== "backendMissing"
  );
  if (down) {
    const stop = describeStop(down.state.stop!, t);
    return [
      backendStep,
      {
        id: "endpoints",
        state: "err",
        say: `${down.backend.name}: ${stop.title}`,
        who: "yours",
        short: stop.title,
        subject: {
          kind: "Service",
          name: down.backend.name,
          namespace: down.namespace,
        },
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
        ? t("empty", "gwExternalName")
        : t("count", "gwEndpointsPublish", { n: ready }) +
          (draining > 0 ? `, ${t("count", "nDraining", { n: draining })}` : ""),
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

function reachableStep(probe: RouteTrace["probe"], t: T): TraceStep {
  if (probe.host == null && probe.address == null) {
    return {
      id: "reachable",
      state: "off",
      say: t("empty", "gwReachableNothing"),
      who: "machine",
    };
  }
  return {
    id: "reachable",
    state: "blind",
    say: t("empty", "gwReachableUnchecked"),
    who: "machine",
  };
}

function traceFor(
  route: RouteInfo,
  parent: ParentRefInfo,
  sources: TraceSources,
  t: T
): RouteTrace {
  const namespace = parent.namespace ?? route.namespace;
  const gateway = findGateway(sources.gateways, parent.name, namespace);
  const entries = statusesFor(route, parent);
  const [listener, allowed] = acceptanceSteps(
    route,
    gateway,
    parent,
    entries,
    t
  );
  const [backend, endpoints] = backendSteps(route, sources.backing, t);
  const probe = probeOf(route, gateway, parent);

  const steps: TraceStep[] = [
    classStep(gateway, sources.classes, sources.topologyKnown, t),
    gatewayStep(gateway, parent, route.namespace, sources.topologyKnown, t),
    listener,
    allowed,
    refsStep(route, entries, t),
    backend,
    endpoints,
    reachableStep(probe, t),
  ];

  const firstBroken = steps.findIndex((step) => step.state === "err");
  // Blind because the cluster could not be read, not because nobody has
  // probed yet: the last mile is `who: "machine"` and is blind on every
  // healthy trace by design, so counting it would make every verdict unknown.
  const unread = steps.some(
    (step) => step.state === "blind" && step.who !== "machine"
  );
  if (firstBroken >= 0) {
    for (const step of steps.slice(firstBroken + 1)) {
      step.state = "off";
      step.detail = undefined;
      step.freshness = undefined;
      step.subject = undefined;
      step.addresses = undefined;
      step.forwardPort = undefined;
    }
  }

  return {
    gateway: {
      name: parent.name,
      namespace,
      sectionName: parent.sectionName,
    },
    serving: firstBroken < 0,
    servingKnown: firstBroken >= 0 || !unread,
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
  sources: TraceSources,
  t: T
): RouteTrace[] {
  return route.parentRefs
    .filter((parent) => parent.kind === "Gateway")
    .map((parent) => traceFor(route, parent, sources, t));
}
