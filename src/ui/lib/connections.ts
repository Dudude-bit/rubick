/**
 * The reader's questions, built from the cluster's verbs.
 *
 * `get_resource_connections` returns typed edges — six verbs, nothing
 * inferred — so the backend never has to guess how a page reads them. The
 * grouping lives here instead, in one place, so ten pages asking "what does
 * this need to run" get one answer rather than ten spellings of it.
 *
 * Nothing here re-derives a fact: `Usage` already carries how a volume is
 * mounted and which key an environment variable reads, and this only puts
 * that into a sentence.
 */

import { isBuiltInGroup, type AppLink } from "@/lib/links";
import type { T } from "@/i18n/useT";
import { covers, expiryOf } from "./certificates";
import { isScalable } from "./resource-registry";
import { groupMounts } from "./mounts";
import { rolloutLine, rolloutVerdict } from "./workload-status";
import { exitUnreported, upBetweenCrashes } from "./share/pod-status";
import { gitRevisionLink, type Delivery, type GitLink } from "@/integrations";
import { delivered } from "./delivery";
import { ingressAddressOf, type IngressAddress } from "./ingress-health";
import type { RouteTls } from "./ingress-tls";
import { clusterIpText } from "./cluster-ip";
import { refusalText } from "./create-refusal";
import { makersUnread, stopMood, type StopMood } from "./stop-mood";
import {
  doorDoubt,
  doorDoubtWords,
  refusedStop,
  type DoorAsk,
  type DoorDoubt,
} from "./policy-door";

export { stopMood, type StopMood };
import {
  autoscalerRange,
  autoscalerReplicas,
  autoscalers,
  budgetRoom,
  budgetRule,
} from "./governance";
import {
  endpointAddress,
  endpointCount,
  publishedFor,
  sourceMark,
  unpublishedNote,
} from "./published";
import type { en } from "@/i18n/catalogue";
import type {
  ChainStop,
  ConnectionEdge,
  NotServing,
  ObjectFacts,
  ObjectRef,
  Relation,
  IngressClassBinding,
  NearSelector,
  PublishedEndpoint,
  ResourceConnections,
  ServicePublished,
  SharedCause,
  TlsCertificate,
  Unread,
  UnexploredKind,
  Usage,
} from "@/generated/types";
import { declaredQuantity } from "./metric-format";
import { currentCause, sharedText } from "./pod-cause";

type Named = Pick<ObjectRef, "kind" | "name" | "namespace">;

function sameObject(a: Named, b: Named): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    (a.namespace ?? null) === (b.namespace ?? null)
  );
}

const refKey = (ref: ObjectRef) =>
  `${ref.kind}/${ref.namespace ?? "-"}/${ref.name}`;

function unique(refs: ObjectRef[]): ObjectRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * "a, and b" for two; "a, b, and c" past that — the mock's rhythm.
 *
 * The last join is a catalogue string because it is a word: English puts
 * "and" there and Russian puts "и", with no comma before it. Hard-coding
 * either one leaves the other language reading a sentence in two.
 */
function sentence(parts: string[], t: T): string {
  const kept = [...new Set(parts.filter(Boolean))];
  if (kept.length <= 1) return kept[0] ?? "";
  return t("nav", "listAndLast", {
    list: kept.slice(0, -1).join(", "),
    last: kept[kept.length - 1],
  });
}

const join = (...parts: (string | null | undefined | false)[]) =>
  parts.filter(Boolean).join(" · ");

// --- what the cluster said, in words ------------------------------------

/**
 * One way an object is drawn on. Every field here came from the backend.
 *
 * `containers` is the containers this one line covers — several, where a
 * mount was grouped — and null where naming them would be noise.
 */
function describeUsage(
  usage: Usage,
  containers: string[] | null,
  t: T
): string {
  // Leading rather than trailing: on their own lines these read as a column
  // of containers, and "mounted at /etc/app in app" invites the path to be
  // read as part of the sentence.
  const inside = (text: string) =>
    containers && containers.length > 0
      ? `${containers.join(", ")} · ${text}`
      : text;
  switch (usage.how) {
    case "mount": {
      const where = usage.projected
        ? t("nav", "projectedInto", { path: usage.path })
        : t("nav", "mountedAt", { path: usage.path });
      const from = usage.subPath
        ? t("nav", "fromSubPath", { subPath: usage.subPath })
        : "";
      return inside(
        `${where}${from}${usage.readOnly ? t("nav", "readOnlySuffix") : ""}`
      );
    }
    case "unmounted":
      return t("nav", "inVolumeUnmounted", { volume: usage.volume });
    case "env":
      return inside(
        t("nav", "envReadsKey", { env: usage.name, key: usage.key })
      );
    case "envFrom":
      return inside(t("nav", "everyKeyBecomesEnv"));
    case "imagePullSecret":
      return t("nav", "usedToPullImages");
    case "identity":
      return t("nav", "identityItRunsAs");
    case "ingressTls":
      return usage.hosts.length > 0
        ? t("nav", "servesTlsFor", { hosts: usage.hosts.join(", ") })
        : t("nav", "servesTlsForHosts");
  }
}

/**
 * Every way one object draws on another.
 *
 * Mounts are grouped before they are worded, so two containers mounting one
 * volume at one path are one line naming both rather than the same path
 * printed twice. Two mounts that genuinely differ — the same path, one of
 * them read-only — stay two lines, because the difference is the finding.
 *
 * Two ways read as one sentence and the row stays one line; past that each
 * way becomes its own line. Containers are named only where they tell two
 * lines apart.
 *
 * No "all containers" here, unlike the pod's Volumes block: that summary is
 * a claim about a denominator — the pod's whole container list — which the
 * edge does not carry, and which a ConfigMap page listing four pods that use
 * it could not know for any of them.
 */
export function describeUsages(usages: Usage[], t: T): string[] {
  const groups = groupMounts(usages.filter((use) => use.how === "mount"));
  const rest = usages.filter((use) => use.how !== "mount");
  const drawnBy = new Set(
    usages.flatMap((use) => ("container" in use ? [use.container] : []))
  );

  const say = (containers: boolean) => [
    ...new Set([
      ...groups.map((group) =>
        describeUsage(group.mount, containers ? group.containers : null, t)
      ),
      ...rest.map((use) =>
        describeUsage(
          use,
          containers && "container" in use ? [use.container] : null,
          t
        )
      ),
    ]),
  ];

  const ways = say(false);
  if (ways.length > 2 || (ways.length > 1 && drawnBy.size > 1))
    return say(true);
  return [sentence(ways, t)].filter(Boolean);
}

/** What the far end knows about itself, where it is worth a line. */
function describeFacts(facts: ObjectFacts | null, t: T): string | null {
  if (!facts) return null;
  switch (facts.kind) {
    case "claim":
      return join(
        facts.capacity && declaredQuantity("storage", facts.capacity),
        facts.storageClass,
        facts.phase
      );
    case "pod":
      return upBetweenCrashes({ status: facts })
        ? join(facts.display, t("readings", "upBetweenCrashes"))
        : exitUnreported({ status: facts })
          ? join(facts.display, t("readings", "exitUnreported"))
          : facts.display;
    case "workload": {
      if (facts.revision === null) {
        const counted = t("count", "readyOfTotal", {
          ready: facts.readyReplicas,
          total: facts.replicas,
        });
        return facts.rollout && rolloutLine(facts.rollout, t)
          ? join(rolloutVerdict(facts.rollout, t).text, counted)
          : counted;
      }
      const revision = t("columns", "revisionInline", { n: facts.revision });
      return join(
        facts.current
          ? t("readings", "revisionCurrent", { said: revision })
          : revision,
        t("cluster", "podCount", { n: facts.replicas })
      );
    }
    case "service":
      return serviceVia(facts, t);
    case "ingress":
      return facts.className;
    case "gateway":
      return facts.className;
    case "autoscaler":
      return join(autoscalerRange(facts, t), autoscalerReplicas(facts, t));
    case "budget":
      return join(budgetRule(facts, t), budgetRoom(facts, t));
    case "node":
      return nodeCapacity(facts, t);
  }
}

/**
 * What the scheduler may still hand out here, and whether it is allowed to.
 *
 * Allocatable, not capacity: capacity is what the machine has and allocatable
 * is what is left once the kubelet has reserved its own, and a pod is placed
 * against the second. Cordoned is last because it is the one that changes what
 * the rest of the line means — the room is there and nothing may take it.
 */
function nodeCapacity(
  facts: Extract<ObjectFacts, { kind: "node" }>,
  t: T
): string {
  return join(
    facts.cpu && `${facts.cpu} CPU`,
    facts.memory && declaredQuantity("memory", facts.memory),
    !facts.schedulable && t("readings", "nodeCordonedWord")
  );
}

function serviceVia(
  facts: Extract<ObjectFacts, { kind: "service" }>,
  t: T
): string {
  const address =
    facts.externalName !== null
      ? `ExternalName → ${facts.externalName}`
      : join(facts.type, facts.clusterIp && clusterIpText(facts.clusterIp, t));
  return join(
    address,
    facts.selector
      ? t("nav", "selectsLabels", { selector: facts.selector })
      : t("nav", "noSelector")
  );
}

function servicePorts(ref: ObjectRef): string | null {
  const facts = ref.facts;
  if (facts?.kind !== "service" || facts.ports.length === 0) return null;
  return facts.ports
    .map((port) =>
      String(port.port) === port.targetPort
        ? `:${port.port}`
        : `:${port.port} → ${port.targetPort}`
    )
    .join(" · ");
}

/**
 * What was left unverified, and never silently.
 *
 * `notChecked` is the whole reason `Existence` is three-valued: a ConfigMap
 * whose lookup the cluster refused was only read off the pod spec, so a
 * typo'd name and a real one arrive here looking identical. Saying so is
 * cheap; implying the app checked is not.
 */
export function describeExistence(
  ref: ObjectRef,
  t: T,
  verifiable = true
): string | null {
  if (ref.existence === "missing") return t("nav", "notInThisNamespace");
  if (ref.existence === "notChecked" && verifiable)
    return t("nav", "notChecked");
  return null;
}

export type HopTone = "on" | "info" | "unknown" | "warn" | "bad";

const STOP_TONE: Record<StopMood, HopTone> = {
  fault: "bad",
  idle: "on",
  coming: "info",
  unchecked: "unknown",
};

export const stopTone = (stop: ChainStop): HopTone => STOP_TONE[stopMood(stop)];

/** How the chain draws a hop, on the page and in a shared file alike. */
export function hopTone(hop: ChainHop): HopTone {
  if (hop.at === "stop") return STOP_TONE[hop.mood];
  // A hop the app could not look up is not a hop it found. The Services
  // list being refused hands the chain a backend with `notChecked`, and
  // drawing it in the ordinary tone made it indistinguishable from a
  // Service that exists and is healthy — on the one view that exists to
  // show where traffic stops.
  if (hop.at === "object" && hop.object.existence === "notChecked")
    return "warn";
  if (hop.at === "published") return hop.tone;
  if (hop.at === "controller") return hop.binding.resolved ? "on" : "bad";
  if (hop.at === "certificate") {
    // Not read back yet is not a finding; read back and unreadable is.
    if (!hop.read) return "on";
    // A host served over TLS under a Secret that is not there gets the
    // controller's default certificate, or no HTTPS at all: a browser refuses.
    if (!hop.read.certificate)
      return hop.read.problem?.says === "noSecret" ? "bad" : "warn";
    const tone = expiryOf(hop.read.certificate).tone;
    return tone === "err" ? "bad" : (tone ?? "on");
  }
  return "on";
}

// --- where the path stops ----------------------------------------------

const NONE_READY_UNDER: Record<NotServing, keyof typeof en.empty> = {
  unscheduled: "stopNotScheduled",
  starting: "stopNotStarted",
  crashLooping: "stopCrashLooping",
  terminating: "stopTerminating",
  failingReadiness: "stopRunningNoneReady",
  finished: "stopFinished",
  mixed: "stopNoneReady",
  other: "stopNoneReady",
  inSlices: "stopNoneReady",
  comingUp: "stopComingUp",
  podsUnread: "podsNotRead",
};

/** What a stopped path says in the column, in four words or fewer. */
export function stopUnder(
  stop: Extract<ChainStop, { service: ObjectRef }>
): keyof typeof en.empty {
  switch (stop.reason) {
    case "backendMissing":
      return "stopNoServiceToSendTo";
    case "selectsNothing":
      return "stopSelectorMatchesNothing";
    case "scaledToZero":
      return "stopScaledToZeroUnder";
    case "podsBeingMade":
      return "stopPodsBeingMadeUnder";
    case "podsRefused":
      return "stopPodsRefusedUnder";
    case "publishesNothingYet":
      return stop.podsUnread ? "podsNotRead" : "stopNothingPublishedYet";
    case "noneReady":
      return NONE_READY_UNDER[stop.why];
    case "publishesNothing":
      return "stopNoPortToSendTo";
    case "policyRefuses":
      return "stopPolicyShutUnder";
  }
}

/** Why none is ready, each sentence sending the reader somewhere else. */
const NONE_READY_NOTE: Record<NotServing, keyof typeof en.nav> = {
  unscheduled: "stopNotScheduledNote",
  starting: "stopNotStartedNote",
  crashLooping: "stopCrashLoopingNote",
  terminating: "stopTerminatingNote",
  failingReadiness: "stopFailingReadinessNote",
  finished: "stopFinishedNote",
  mixed: "stopMixedNote",
  other: "stopOtherNote",
  inSlices: "stopInSlicesNote",
  comingUp: "stopComingUpNote",
  podsUnread: "stopPodsUnreadNote",
};

/** Pods that are still coming up, or were not read, have no cause to tell yet. */
const UNTOLD: ReadonlySet<NotServing> = new Set([
  "comingUp",
  "podsUnread",
  "inSlices",
]);

/** The cause the pods behind a stop share, where none of them is ready for one. */
export function stopCause(stop: ChainStop): SharedCause | null {
  if (stop.reason !== "noneReady" || !stop.cause || UNTOLD.has(stop.why))
    return null;
  return currentCause(stop.cause.cause) ? stop.cause : null;
}

/** Where a none-ready count comes from: the slices' addresses, or the pods the selector picked. */
const SLICES_COUNTED: ReadonlySet<NotServing> = new Set([
  "inSlices",
  "podsUnread",
]);

/** The named targetPorts no container declares, as the Service asks for them. */
export function askedPorts(names: string[], t: T): string {
  return names.map((name) => t("nav", "targetPortNamed", { name })).join(", ");
}

/**
 * The four ways a path stops, each a different repair.
 *
 * `publishesNothing` is the sharpest: a healthy selector, healthy pods, a
 * green everything and no traffic at all, because the Service asks for a port
 * name no container declares. No deduction from pod readiness can see it —
 * the pods really are Ready, and it is the endpoint controller that skipped
 * them.
 */
export function describeStop(
  stop: ChainStop,
  t: T
): { title: string; note: string } {
  switch (stop.reason) {
    case "publishesNothing": {
      const matched =
        stop.readyPods === stop.pods
          ? t("count", "podsMatchAllReady", { n: stop.pods })
          : t("count", "podsMatchSomeReady", {
              n: stop.pods,
              ready: stop.readyPods,
            });
      if (stop.unnamedPorts.length === 0) {
        return {
          title: t("nav", "servicePublishesNoEndpoint"),
          note: t("nav", "stopNoSliceNote", { matched }),
        };
      }
      const asked = askedPorts(stop.unnamedPorts, t);
      return {
        title: t("nav", "servicePublishesNoEndpoint"),
        note: t("nav", "stopUnnamedPortNote", { matched, asked }),
      };
    }
    case "backendMissing":
      return {
        title: t("nav", "stopNoServiceNamed", { name: stop.service.name }),
        // The kind that names the backend, not a hardcoded "Ingress": a
        // Gateway API route reaches this same branch.
        note: t("nav", "backendNeverCreated", { kind: stop.ingress.kind }),
      };
    case "selectsNothing":
      return stop.near
        ? {
            title: t("count", "podsCarryPartOf", {
              n: stop.near.pods.length,
              carries: stop.near.carries,
              lacks: stop.near.lacks,
            }),
            note: t("nav", "stopNearMissNote", {
              pods: namesOf(stop.near.pods, t),
              lacks: stop.near.lacks,
            }),
          }
        : {
            title: t("nav", "stopNoPodCarries", { selector: stop.selector }),
            note: t(
              "nav",
              makersUnread(stop)
                ? "stopMakersUnreadNote"
                : "connectionRefusedNothingBehind"
            ),
          };
    case "scaledToZero":
      return scaledToZeroWords(
        stop.workloads.map((workload) => workload.name),
        t
      );
    case "podsBeingMade": {
      const names = stop.workloads.map((workload) => workload.name);
      return {
        title:
          names.length === 1
            ? t("nav", "stopPodsBeingMade", {
                selector: stop.selector,
                name: names[0],
              })
            : t("nav", "stopPodsBeingMadeSeveral", {
                selector: stop.selector,
                names: names.join(", "),
              }),
        note: t("nav", "stopPodsBeingMadeNote"),
      };
    }
    case "podsRefused":
      return {
        title: refusalText(stop.said, t),
        note: t("nav", "stopPodsRefusedNote", {
          selector: stop.selector,
          workloads: stop.workloads
            .map((workload) => `${workload.kind} ${workload.name}`)
            .join(", "),
        }),
      };
    // Said by a reader holding the endpoints and no pod list: it knows
    // nothing arrives and cannot say whether that is a selector matching
    // nothing or pods that have no address yet.
    case "publishesNothingYet":
      return {
        title: t("nav", "stopPublishesNothingYet", { selector: stop.selector }),
        note: t(
          "nav",
          stop.podsUnread
            ? "stopPodsUnreadNote"
            : "connectionRefusedNothingBehind"
        ),
      };
    case "noneReady": {
      const cause = stopCause(stop);
      return {
        title: t(
          "count",
          SLICES_COUNTED.has(stop.why)
            ? "endpointsNoneReady"
            : "podsCarryNotReady",
          { n: stop.pods, selector: stop.selector }
        ),
        note: cause
          ? sharedText(cause, t)
          : t("nav", NONE_READY_NOTE[stop.why]),
      };
    }
    case "policyRefuses": {
      const names = stop.policies.join(", ");
      const n = stop.policies.length;
      if (stop.client)
        return {
          title: t("count", "policyRefusesClient", {
            n,
            names,
            client: stop.client.name,
          }),
          note: t("nav", "stopPolicyClientNote", {
            client: stop.client.name,
            namespaces: stop.client.namespaces.join(", "),
          }),
        };
      if (stop.noRules)
        return {
          title: t("count", "policyShutsPods", { n, names }),
          note: t("nav", "stopPolicyNoRulesNote"),
        };
      const ports = stop.ports
        .map((port) => t("nav", "portNumbered", { n: port }))
        .join(", ");
      return {
        title: t("count", "policyShutsPort", { n, names, ports }),
        note: t("nav", "stopPolicyPortNote", { ports }),
      };
    }
    case "routeNotAccepted":
      return {
        title: t("nav", "stopRouteNotAcceptedTitle", {
          gateway: stop.gateway.name,
        }),
        note: t("nav", "stopRouteNotAcceptedNote", { said: saidBy(stop) }),
      };
    case "routeRefsUnresolved":
      return {
        title: t(
          "nav",
          stop.conditionReason === "RefNotPermitted"
            ? "stopRefNotPermittedTitle"
            : "stopRefUnresolvedTitle"
        ),
        note: t("nav", "stopRefsUnresolvedNote", { said: saidBy(stop) }),
      };
    case "gatewayMissing":
      return {
        title: t("nav", "stopGatewayMissingTitle"),
        note: t("nav", "stopGatewayMissingNote", {
          route: stop.route.name,
          gateway: stop.gateway.namespace
            ? `${stop.gateway.namespace}/${stop.gateway.name}`
            : stop.gateway.name,
        }),
      };
  }
}

/** The controller's own words after its condition, left as it wrote them. */
function saidBy(stop: {
  conditionReason: string | null;
  message: string | null;
}): string {
  const message = stop.message?.replace(/\.\s*$/, "");
  return (
    (stop.conditionReason ? ` (${stop.conditionReason})` : "") +
    (message ? `: ${message}` : "")
  );
}

// --- the traffic chain --------------------------------------------------

export interface ChainHopObject {
  at: "object";
  object: ObjectRef;
  /** The page's own subject: named rather than linked to itself. */
  self: boolean;
  /** Beside the name, in mono — the thing that makes it this hop. */
  detail: string | null;
  /** Under the name, quieter. */
  via: string | null;
  /**
   * Where this hop is reachable from outside, scheme included.
   *
   * Only an Ingress ever has one, and only where the rule names a host: the
   * scheme comes from whether `spec.tls` covers that host, which the routing
   * edge already states, and a URL with a placeholder host is an address
   * nobody can paste anywhere. Empty for every other hop.
   */
  urls: string[];
  /**
   * What that hostname has to resolve to, where the page has read it, as the
   * Ingress page reads it: an empty `status.loadBalancer` is "pending" only
   * where a controller serves the class.
   *
   * `null` where nothing was read, which is not the same as *read and empty*
   * — an Ingress the controller has not published is unreachable whatever its
   * rules say, and that is a sentence the chain owes the reader rather than a
   * gap it can leave to be inferred.
   */
  address: { state: IngressAddress; addresses: string[] } | null;
}

/**
 * The last hop, and it is the cluster's own answer rather than ours.
 *
 * Counting `Ready` conditions over the pods a selector matches is a deduction
 * wrong in both the directions that matter: a draining pod reads as dead
 * while it is still taking traffic, and a Service that publishes nothing at
 * all reads as green.
 */
export interface ChainHopPublished {
  at: "published";
  published: ServicePublished;
  /** The pod behind the first address, so the hop has a name and not only a
   * number. Null where the endpoints name no pod, which a hand-written slice
   * does not, or none of the subject workload's own. */
  first: ObjectRef | null;
  /** The first address itself, for a slice that names no pod. */
  address: string | null;
  summary: string;
  tone: "on" | "warn";
}

export interface ChainHopStop {
  at: "stop";
  title: string;
  note: string;
  mood: StopMood;
  /** The objects the title names, to open from the stop. */
  objects?: ObjectRef[];
  /** A NetworkPolicy refuses the connection: there are pods behind it. */
  shut?: boolean;
  /** The addresses it stops, where it does not stop every one on the path. */
  only?: string[];
}

/** Three names at most, and how many more. */
function namesOf(objects: ObjectRef[], t: T): string {
  const shown = objects
    .slice(0, 3)
    .map((object) => object.name)
    .join(", ");
  return objects.length > 3
    ? shown + t("count", "andNMore", { n: objects.length - 3 })
    : shown;
}

function scaledToZeroWords(
  names: string[],
  t: T
): { title: string; note: string } {
  return {
    title:
      names.length === 1
        ? t("nav", "stopScaledToZero", { name: names[0] })
        : t("nav", "stopScaledToZeroSeveral", { names: names.join(", ") }),
    note: t("nav", "stopScaledToZeroNote"),
  };
}

/** A stop as the chain says it about `subject`, whose own pods are `own` where they were read. */
export function chainStopHop(
  stop: ChainStop,
  subject: ObjectRef,
  t: T,
  own: ReadonlySet<string> | null = null
): ChainHopStop {
  if (
    stop.reason === "selectsNothing" &&
    subject.facts?.kind === "workload" &&
    subject.facts.rollout?.state === "idle"
  ) {
    return {
      at: "stop",
      mood: "idle",
      ...scaledToZeroWords([subject.name], t),
    };
  }
  const said = describeStop(stop, t);
  // Big-pull counted the terminating pods of a Deployment deleted under its
  // name as "its pods": the selector's count is not the workload's.
  if (
    stop.reason === "noneReady" &&
    !SLICES_COUNTED.has(stop.why) &&
    own &&
    own.size < stop.pods
  ) {
    said.title =
      own.size === 0
        ? t("count", "podsCarryNoneOwn", {
            n: stop.pods,
            selector: stop.selector,
            kind: subject.kind,
          })
        : t("count", "podsCarrySomeOwn", {
            n: stop.pods,
            selector: stop.selector,
            own: own.size,
            kind: subject.kind,
          });
  }
  return {
    at: "stop",
    mood: stopMood(stop),
    ...said,
    ...(stop.reason === "policyRefuses" && {
      objects: policyRefs(stop.policies, stop.service.namespace),
      shut: true,
    }),
  };
}

const policyRefs = (names: string[], namespace: string | null): ObjectRef[] =>
  names.map((name) => ({
    kind: "NetworkPolicy",
    name,
    namespace,
    existence: "present",
    facts: null,
  }));

/** Policies over the pods that may or may not admit this controller, said as the stop they might be. */
function doorDoubtHop(
  service: ObjectRef,
  doubt: DoorDoubt,
  t: T
): ChainHopStop {
  return {
    at: "stop",
    mood: "unchecked",
    ...doorDoubtWords(doubt, t),
    objects: policyRefs(doubt.policies, service.namespace),
  };
}

/**
 * A workload's own pods, by uid, where they were read: the Service's
 * addresses can be another's, the old pods of one deleted under its name.
 * `null` for a subject with no pods of its own, or whose pods were not read.
 */
export function ownPods(
  conns: ResourceConnections
): ReadonlySet<string> | null {
  const subject = conns.subject;
  if (
    subject.kind === "Service" ||
    subject.kind === "Ingress" ||
    subject.kind === "Pod" ||
    conns.notLookedAt.some((entry) => entry.kind === "Pod")
  )
    return null;
  return new Set(
    verb(conns.edges, "selects")
      .filter(
        (edge) => sameObject(edge.from, subject) && edge.to.kind === "Pod"
      )
      .map((edge) => refKey(edge.to))
  );
}

/**
 * The certificate the connection is made under, above the Ingress.
 *
 * It is a hop rather than a fact on the Ingress hop because it is where the
 * path stops for a browser: an expired certificate refuses the connection
 * before any of the rest of this chain is consulted.
 */
export interface ChainHopCertificate {
  at: "certificate";
  secret: ObjectRef;
  hosts: string[];
  /** `undefined` until the read comes back. */
  read: TlsCertificate | undefined;
}

/**
 * Which controller picks this Ingress up, including "none does".
 *
 * An Ingress object is a request, not a fact. One asking for a class no
 * controller claims looks perfectly configured — correct YAML, no events,
 * no error — and is never served, which is the failure that looks like
 * nothing at all. `IngressClass` is a built-in kind, so this is core.
 */
export interface ChainHopController {
  at: "controller";
  binding: IngressClassBinding;
}

export type ChainHop =
  | ChainHopObject
  | ChainHopPublished
  | ChainHopStop
  | ChainHopCertificate
  | ChainHopController;

export interface ChainPath {
  key: string;
  hops: ChainHop[];
  /** Whether this path stops before it reaches a ready pod. */
  broken: boolean;
}

export interface UnservedIngresses {
  ingresses: number;
  classes: string[];
  available: string[];
}

/** The Ingresses on these paths asking for a class nothing serves, so the repair is said once. */
export function unservedIngresses(
  paths: ChainPath[]
): UnservedIngresses | null {
  const ingresses = new Set<string>();
  const classes = new Set<string>();
  let available: string[] = [];
  for (const path of paths) {
    path.hops.forEach((hop, index) => {
      if (hop.at !== "controller") return;
      const { resolved, requested } = hop.binding;
      if (resolved || !requested) return;
      const next = path.hops[index + 1];
      ingresses.add(
        next?.at === "object" ? refKey(next.object) : `${path.key}#${index}`
      );
      classes.add(requested);
      available = hop.binding.available.map((entry) => entry.name);
    });
  }
  return ingresses.size > 1
    ? { ingresses: ingresses.size, classes: [...classes].sort(), available }
    : null;
}

/**
 * What one Ingress in front of the subject says about itself, read from the
 * Ingress rather than deduced from the edge that names it.
 *
 * Keyed by `refKey` of the Ingress, so a page can fill in as many as it has
 * read and the chain simply draws less for the ones it has not.
 */
export interface RoutedIngress {
  tls: Array<{ secretName: string; hosts: string[] }>;
  /** Who picks it up, including t("nav", "nobodyDoes"). */
  binding: IngressClassBinding | null;
  /**
   * Where the controller published it: `status.loadBalancer.ingress`, as an
   * address or a hostname.
   *
   * Empty is a finding rather than a blank: until something assigns an
   * address nothing reaches the Ingress at all — the most common reason a
   * perfectly correct one "does not work" — so the chain says so instead of
   * printing a URL that resolves to nothing.
   */
  addresses: string[];
}

const verb = <V extends Relation["verb"]>(
  edges: ConnectionEdge[],
  which: V
): (ConnectionEdge & { relation: Extract<Relation, { verb: V }> })[] =>
  edges.filter((edge) => edge.relation.verb === which) as never;

/**
 * A Gateway API route's hop: hostnames rather than one host, and no URL —
 * whether a hostname is served over TLS is the listener's fact, not the
 * route's, and a scheme guessed here would be the chain inventing one.
 */
function gatewayRouteHop(
  edges: (ConnectionEdge & {
    relation: Extract<Relation, { verb: "ruleRoutes" }>;
  })[],
  object: ObjectRef,
  t: T
): ChainHopObject {
  const hostnames = [
    ...new Set(edges.flatMap((edge) => edge.relation.hostnames)),
  ];
  const drained = edges.every((edge) => edge.relation.weight === 0);
  return {
    at: "object",
    object,
    self: false,
    detail: hostnames.join(", ") || null,
    via: drained ? t("nav", "gwWeightZero") : describeFacts(object.facts, t),
    urls: [],
    address: null,
  };
}

const routeRules = (edges: ConnectionEdge[]) =>
  edges.map((edge) => edge.relation as Extract<Relation, { verb: "routes" }>);

const schemesOf = (
  relations: ReturnType<typeof routeRules>,
  object: ObjectRef,
  tlsOf?: RouteTls
) =>
  relations.map((rule) =>
    rule.host && tlsOf ? tlsOf(object, rule.host, rule.tls) : rule.tls
  );

/** The addresses an Ingress's rules hand out; a scheme nobody could settle is no address to hand anybody. */
function routeUrls(
  edges: ConnectionEdge[],
  object: ObjectRef,
  tlsOf?: RouteTls
): string[] {
  const relations = routeRules(edges);
  const schemes = schemesOf(relations, object, tlsOf);
  return [
    ...new Set(
      relations.flatMap((rule, index) =>
        rule.host && schemes[index] !== null
          ? [`${schemes[index] ? "https" : "http"}://${rule.host}${rule.path}`]
          : []
      )
    ),
  ];
}

function routeHop(
  edges: ConnectionEdge[],
  object: ObjectRef,
  t: T,
  known?: RoutedIngress,
  tlsOf?: RouteTls
): ChainHopObject {
  const relations = routeRules(edges);
  const schemes = schemesOf(relations, object, tlsOf);
  const detail = [
    ...new Set(
      relations.map(
        (rule) => `${rule.host ?? `${t("action", "anyHost")} `}${rule.path}`
      )
    ),
  ].join(", ");
  return {
    at: "object",
    object,
    self: false,
    detail,
    via: join(
      schemes.includes(true)
        ? t("nav", "overHttps")
        : schemes.includes(null)
          ? t("empty", "tlsNotChecked")
          : t("nav", "overHttpPlain"),
      describeFacts(object.facts, t)
    ),
    urls: routeUrls(edges, object, tlsOf),
    address: known
      ? {
          state: ingressAddressOf(
            { loadBalancerIps: known.addresses },
            known.binding ?? undefined
          ),
          addresses: known.addresses,
        }
      : null,
  };
}

function serviceHop(object: ObjectRef, self: boolean, t: T): ChainHopObject {
  return {
    at: "object",
    object,
    self,
    detail: servicePorts(object),
    via: describeFacts(object.facts, t),
    urls: [],
    address: null,
  };
}

/** Taking traffic before draining before neither, a terminating one last of its kind: the order a hop names them in. */
const endpointRank = (endpoint: PublishedEndpoint) =>
  (endpoint.ready ? 0 : endpoint.serving ? 2 : 4) +
  (endpoint.terminating ? 1 : 0);

/**
 * What the Service hands to kube-proxy, counted.
 *
 * A draining address counts as taking traffic: kube-proxy falls back to the
 * terminating endpoints when no ready one is left, so a Service down to one
 * draining pod is a restart in progress rather than an outage. Under a
 * workload, `own` names its pods and the counts say they are the Service's.
 */
function publishedHop(
  published: ServicePublished,
  t: T,
  own: ReadonlySet<string> | null
): ChainHopPublished {
  const listed = (
    own
      ? published.endpoints.filter(
          (endpoint) => endpoint.target && own.has(refKey(endpoint.target))
        )
      : [...published.endpoints]
  ).sort((a, b) => endpointRank(a) - endpointRank(b));
  const first = listed[0];
  const rest = (own ? listed.length : endpointCount(published)) - 1;
  const offPort = published.unpublished
    .filter((entry) => entry.inSlice)
    .map((entry) => entry.pod);
  const counts = join(
    published.ready > 0 &&
      t("readings", "publishedCount", { n: published.ready }),
    published.draining > 0 &&
      `${t("readings", "drainingCount", { n: published.draining })}${
        published.ready === 0 ? t("readings", "stillTakingTraffic") : ""
      }`,
    published.notReady > 0 &&
      t("readings", "notReadyEndpoints", { n: published.notReady }),
    sourceMark(published, t)
  );
  const summary = join(
    own && !first && t("readings", "noneOfItsPodsPublished"),
    rest > 0 && t("empty", "andMore", { n: rest }),
    own && counts ? t("readings", "acrossTheService", { counts }) : counts,
    offPort.length > 0 &&
      t("readings", "offPortNamed", {
        n: offPort.length,
        names: namesOf(offPort, t),
      })
  );
  return {
    at: "published",
    published,
    first: first?.target ?? null,
    address: first ? endpointAddress(first) : null,
    summary,
    tone:
      (published.ready === 0 && published.draining > 0) || offPort.length > 0
        ? "warn"
        : "on",
  };
}

/** The subject pod a Service selects and sends nothing, where nothing else stopped the path first. */
function unpublishedHop(
  service: ObjectRef,
  published: ServicePublished | undefined,
  subject: ObjectRef,
  t: T
): ChainHopStop | null {
  const entry = published?.unpublished.find((pod) =>
    sameObject(pod.pod, subject)
  );
  const ready = entry?.pod.facts?.kind === "pod" && entry.pod.facts.ready;
  if (!entry || !(entry.inSlice || ready)) return null;
  return {
    at: "stop",
    title: t("readings", "sendsThisPodNothing", { service: service.name }),
    note: unpublishedNote(entry, t),
    mood: "fault",
  };
}

/**
 * Which Secret an Ingress serves TLS from, and for which hosts.
 *
 * Read off the same `ingressTls` edge the Connections tab uses — no second
 * request, and no second reading of `spec.tls`.
 */
export function tlsSecrets(
  conns: ResourceConnections
): { secret: ObjectRef; hosts: string[] }[] {
  return verb(conns.edges, "uses")
    .filter(
      (edge) =>
        sameObject(edge.from, conns.subject) && edge.to.kind === "Secret"
    )
    .flatMap((edge) =>
      edge.relation.usages
        .filter((use) => use.how === "ingressTls")
        .map((use) => ({ secret: edge.to, hosts: use.hosts }))
    );
}

/**
 * Whether a `spec.tls` entry covers any of the hosts on this path.
 *
 * An entry with no hosts is the catch-all the Ingress spec allows, and it
 * covers every host the Ingress routes — which is why an empty list is a
 * match rather than a miss. Where hosts are named, matching them is
 * {@link covers}'s job rather than string equality: a Secret named for
 * `*.example.com` is the common case, and exact matching silently draws no
 * certificate hop for it at all.
 */
function servesAny(tlsHosts: string[], pathHosts: string[]): boolean {
  if (tlsHosts.length === 0) return true;
  return pathHosts.some((host) => host === "" || covers(tlsHosts, host));
}

/**
 * Whether a `spec.tls` entry is a certificate any of these hosts is served
 * under, not one its controller only loads. Traefik loads every Secret the
 * field names and serves the router as plain HTTP unless it asks for TLS.
 */
function servedUnder(
  ingress: ObjectRef,
  tlsHosts: string[],
  pathHosts: string[],
  tlsOf: RouteTls | undefined
): boolean {
  if (!tlsOf) return true;
  return pathHosts.some(
    (host) =>
      host === "" ||
      ((tlsHosts.length === 0 || covers(tlsHosts, host)) &&
        tlsOf(ingress, host, true) !== false)
  );
}

interface DoorWay {
  controller: string | null;
  port: string | null;
  urls: string[];
}

/** Each controller's verdict at the pods' door, said once, about the addresses that controller serves. */
function doorHops(
  ways: DoorWay[],
  published: ServicePublished,
  ask: DoorAsk,
  subject: ObjectRef,
  t: T,
  own: ReadonlySet<string> | null
): ChainHopStop[] {
  const said = new Map<string, ChainHopStop>();
  for (const { controller, port, urls } of ways) {
    if (controller === null) continue;
    const read = ask(controller);
    const refused = refusedStop(published, port, read);
    const doubt = refused ? null : doorDoubt(published, port, read, controller);
    const hop = refused
      ? chainStopHop(refused, subject, t, own)
      : doubt
        ? doorDoubtHop(published.service, doubt, t)
        : null;
    if (!hop) continue;
    const key = `${hop.title}\n${hop.note}`;
    const only = [...(said.get(key)?.only ?? []), ...urls];
    said.set(key, { ...hop, only: [...new Set(only)] });
  }
  return [...said.values()];
}

/**
 * How traffic gets in, one path per Service that fronts the subject.
 *
 * A path with a single hop is not a path — a Service nothing routes to and
 * that selects nothing has only itself to say — so it is dropped here and
 * `chainSilence` states the absence in one line instead. That is what keeps a
 * Deployment with no Service in front of it from costing a diagram.
 */
export function trafficChains(
  conns: ResourceConnections,
  t: T,
  /**
   * What the page has read beyond the edges. Every field is optional and
   * the chain is whole without any of them — the hops they add extend the
   * path, they never replace part of it.
   */
  extra: {
    certificates?: Map<string, TlsCertificate>;
    /** The binding for the subject Ingress, on the Ingress's own page. */
    controller?: IngressClassBinding;
    /**
     * What the Ingresses *in front of* the subject say about themselves, for
     * a page whose subject is not one.
     *
     * The neighbourhood answer carries the routing edges and the Ingress's
     * class, and stops there — an Ingress's `spec.tls` is only walked when
     * the Ingress is the subject. Without this a Deployment could say which
     * hostname reaches it and never whether that hostname is served over TLS.
     */
    routing?: Map<string, RoutedIngress>;
    /**
     * Whether a host is served over TLS once the controllers have spoken.
     * Without it a route reads `spec.tls` alone, which a cloud certificate
     * in an annotation and a Traefik router both contradict.
     */
    tlsOf?: RouteTls;
    /** Who each Ingress's controller connects from, to judge the NetworkPolicies over the pods. */
    door?: DoorAsk;
  } = {}
): ChainPath[] {
  const subject = conns.subject;
  const routes = verb(conns.edges, "routes");
  const ruleRoutes = verb(conns.edges, "ruleRoutes");
  const attaches = verb(conns.edges, "attachesTo");
  const selects = verb(conns.edges, "selects");
  const tls = tlsSecrets(conns);
  const own = ownPods(conns);

  const fronting: ObjectRef[] =
    subject.kind === "Service"
      ? [subject]
      : subject.kind === "Ingress"
        ? unique(routes.map((edge) => edge.to))
        : unique(
            selects
              .filter(
                (edge) =>
                  edge.from.kind === "Service" && sameObject(edge.to, subject)
              )
              .map((edge) => edge.from)
          );

  return fronting
    .map((service): ChainPath => {
      // Only the Service-anchored stops belong to this hop; the Gateway API
      // ones stop at a route or a Gateway and are drawn on their own hops.
      const stop = conns.stops.find(
        (entry) => "service" in entry && sameObject(entry.service, service)
      );
      const published = publishedFor(conns, service);

      const hops: ChainHop[] = [];
      const ways: DoorWay[] = [];
      if (subject.kind === "Ingress") {
        const mine = routes.filter((edge) => sameObject(edge.to, service));
        const hosts = mine.map((edge) => edge.relation.host ?? "");
        for (const edge of mine) {
          ways.push({
            controller: extra.controller?.controller ?? null,
            port: edge.relation.port,
            urls: routeUrls([edge], subject, extra.tlsOf),
          });
        }
        for (const entry of tls.filter(
          (cert) =>
            servesAny(cert.hosts, hosts) &&
            servedUnder(subject, cert.hosts, hosts, extra.tlsOf)
        )) {
          hops.push({
            at: "certificate",
            secret: entry.secret,
            hosts: entry.hosts,
            read: extra.certificates?.get(entry.secret.name),
          });
        }
        if (extra.controller) {
          hops.push({ at: "controller", binding: extra.controller });
        }
        hops.push({
          ...routeHop(
            mine,
            subject,
            t,
            extra.routing?.get(refKey(subject)),
            extra.tlsOf
          ),
          self: true,
        });
        hops.push(
          service.kind === "Service"
            ? serviceHop(service, false, t)
            : {
                at: "object",
                object: service,
                self: false,
                detail: null,
                via: t("nav", "resourceBackend"),
                urls: [],
                address: null,
              }
        );
      } else {
        // One Ingress at a time, and its own certificate and controller above
        // it: two Ingresses fronting the same Service can be served by
        // different classes under different certificates, and a single shared
        // hop at the top would state one of those as if it were both.
        for (const edge of routes.filter((entry) =>
          sameObject(entry.to, service)
        )) {
          const known = extra.routing?.get(refKey(edge.from));
          const host = edge.relation.host ?? "";
          const route = routeHop([edge], edge.from, t, known, extra.tlsOf);
          ways.push({
            controller: known?.binding?.controller ?? null,
            port: edge.relation.port,
            urls: route.urls,
          });
          for (const entry of known?.tls ?? []) {
            if (!servesAny(entry.hosts, [host])) continue;
            if (!servedUnder(edge.from, entry.hosts, [host], extra.tlsOf))
              continue;
            hops.push({
              at: "certificate",
              secret: {
                kind: "Secret",
                name: entry.secretName,
                namespace: edge.from.namespace,
                existence: "notChecked",
                facts: null,
              },
              hosts: entry.hosts,
              read: extra.certificates?.get(entry.secretName),
            });
          }
          if (known?.binding) {
            hops.push({ at: "controller", binding: known.binding });
          }
          hops.push(route);
        }
        // One Gateway API route at a time, its Gateway above it, and its own
        // stops right where they happen — a refusal written by the
        // controller belongs on the route, not at the far end of the path.
        const byRoute = new Map<string, (typeof ruleRoutes)[number][]>();
        for (const edge of ruleRoutes.filter((entry) =>
          sameObject(entry.to, service)
        )) {
          const key = refKey(edge.from);
          byRoute.set(key, [...(byRoute.get(key) ?? []), edge]);
        }
        for (const mine of byRoute.values()) {
          const route = mine[0].from;
          for (const up of attaches.filter((entry) =>
            sameObject(entry.from, route)
          )) {
            hops.push({
              at: "object",
              object: up.to,
              self: false,
              detail: up.relation.sectionName
                ? t("nav", "gwSectionNamed", { name: up.relation.sectionName })
                : null,
              via: describeFacts(up.to.facts, t),
              urls: [],
              address: null,
            });
          }
          hops.push(gatewayRouteHop(mine, route, t));
          // Its hostnames hand out no address, so it stops none an Ingress does.
          for (const entry of conns.stops) {
            if ("route" in entry && sameObject(entry.route, route)) {
              hops.push({ ...chainStopHop(entry, subject, t, own), only: [] });
            }
          }
        }
        hops.push(serviceHop(service, subject.kind === "Service", t));
      }

      if (
        subject.kind !== "Service" &&
        subject.kind !== "Ingress" &&
        subject.kind !== "Pod"
      ) {
        hops.push({
          at: "object",
          object: subject,
          self: true,
          detail: null,
          via: null,
          urls: [],
          address: null,
        });
      }
      if (subject.kind === "Pod") {
        hops.push({
          at: "object",
          object: subject,
          self: true,
          detail: null,
          via: describeFacts(subject.facts, t),
          urls: [],
          address: null,
        });
      }

      // A route-level refusal breaks the path even where the Service behind
      // it is perfectly healthy — an unaccepted route serves nothing.
      const routeBroken = hops.some((hop) => hop.at === "stop");
      const said =
        (stop ? chainStopHop(stop, subject, t, own) : null) ??
        (subject.kind === "Pod"
          ? unpublishedHop(service, published, subject, t)
          : null);

      // A shut door stands after the pods it shuts, which are published.
      const shut = stop?.reason === "policyRefuses";
      if (said && !shut) hops.push(said);
      else if (
        subject.kind !== "Pod" &&
        published &&
        endpointCount(published) > 0
      )
        hops.push(publishedHop(published, t, own));
      if (said && shut) hops.push(said);
      const doors =
        extra.door && published && !stop
          ? doorHops(ways, published, extra.door, subject, t, own)
          : [];
      hops.push(...doors);

      return {
        key: refKey(service),
        hops,
        broken:
          said?.mood === "fault" ||
          routeBroken ||
          doors.some((hop) => hop.mood === "fault"),
      };
    })
    .filter((path) => path.hops.length > 1);
}

/**
 * The one line that replaces a chain there is no chain to draw.
 *
 * The backend listed every Service in the namespace, so this is a checked
 * claim rather than an absence of data — which is the only reason it is
 * allowed to be this short.
 */
export function chainSilence(conns: ResourceConnections, t: T): string | null {
  const subject = conns.subject;
  // Every sentence below states a negative, and a negative is only ours to
  // state about a list that answered. With Services unread, "no Service
  // selects this pod" is the app reporting its own blind spot as a fact
  // about the cluster, which is the one thing this file exists to prevent.
  if (conns.notLookedAt.some((entry) => entry.kind === "Service")) return null;
  const facts = subject.facts;
  if (subject.kind === "Service") {
    if (facts?.kind === "service" && facts.externalName !== null) {
      return t("nav", "serviceResolvesExternal", {
        name: facts.externalName,
      });
    }
    if (facts?.kind === "service" && facts.selector === null) {
      return t("nav", "endpointsByHandNoneWritten");
    }
    return null;
  }
  if (subject.kind === "Ingress") {
    return t("nav", "ingressStatesNoBackend");
  }
  const closest = closestSelector(conns);
  if (closest) return nearMissWords(conns.subject, closest, t);
  if (subject.kind === "Pod") {
    return t("nav", "noServiceSelectsPod");
  }
  return t("nav", "noServiceSelectsThese", { kind: subject.kind });
}

export interface ClosestSelector {
  near: NearSelector;
  more: number;
}

/** The Service one label short of selecting a subject that none selects. */
export function closestSelector(
  conns: ResourceConnections
): ClosestSelector | null {
  if (conns.notLookedAt.some((entry) => entry.kind === "Service")) return null;
  const [near, ...rest] = conns.nearlySelectedBy ?? [];
  return near ? { near, more: rest.length } : null;
}

/**
 * The sentence naming that Service. `service` stays a placeholder for a
 * caller that draws the name as a link through `parts`.
 */
export function nearMissWords(
  subject: ObjectRef,
  { near, more }: ClosestSelector,
  t: T,
  service: string = near.service.name
): string {
  const values = {
    service,
    more: more > 0 ? t("count", "andNMore", { n: more }) : "",
    carries: near.carries,
    lacks: near.lacks,
    kind: subject.kind,
  };
  return subject.kind === "Pod"
    ? t("nav", "noServiceSelectsPodNear", values)
    : t("nav", "noServiceSelectsTheseNear", values);
}

// --- the tab -----------------------------------------------------------

/**
 * A far end that is not in the cluster at all.
 *
 * The one edge whose other side is a commit: every other verb joins two
 * objects an API server can be asked about, while `delivers` joins an object
 * to the repository that made it. It belongs in the same list rather than a
 * box of its own because it answers the question the ownership walk answers —
 * *what made this* — and answers it more truly than the ReplicaSet does.
 */
export interface OutsideEnd {
  /** The controller's object, and where it is in this app. */
  name: string;
  to: AppLink;
  /** What it applied, and a page to read it on where the remote resolves. */
  revision: string | null;
  link: GitLink | null;
}

export interface ConnRow {
  /** Sort order, where the group has one. Not a label — see NEED_LABEL. */
  rank?: number;
  key: string;
  /** Left column. Empty continues the row above, as a table of facts does. */
  label: string;
  object: ObjectRef | null;
  /** Set instead of `object` for the one edge that leaves the cluster. */
  outside?: OutsideEnd;
  /** What the far end knows about itself, beside the name. */
  detail: string;
  /** The API server's refusal of its pods, said as a cause under the name. */
  refused?: string;
  /** Every way the subject draws on it — one line each past two. */
  ways: string[];
  /**
   * Whether this row is worth saying t("nav", "notChecked") on.
   *
   * Only where existence bears on the claim the group makes. "If one of these
   * is missing the pod does not start" is such a claim, so a name the app
   * read off a pod spec and never looked up has to say so there; a Node the
   * pod is demonstrably running on does not, because an admission repeated on
   * every row is one nobody reads. A `missing` object always says so, in
   * every group.
   */
  verifiable?: boolean;
  /** Set where the row is the app admitting it did not look. */
  unasked?: boolean;
  /** Keys this row reads that the subject was read and found not to hold. */
  missingKeys?: { key: string; optional: boolean; from: string }[];
}

export interface ConnGroup {
  key: string;
  title: string;
  caption: string | null;
  rows: ConnRow[];
}

/**
 * Which question a thing a pod spec names is an answer to — a catalogue key
 * rather than the words.
 *
 * The key must not be the label: the sort below looks it up in an order list,
 * and a label doing double duty as a sort key ranks every row last the moment
 * the label stops being English.
 */
const NEED_LABEL: Record<string, NeedKey> = {
  ConfigMap: "configuration",
  Secret: "configuration",
  PersistentVolumeClaim: "storage",
  ServiceAccount: "identity",
};

type NeedKey = "configuration" | "tlsCertificate" | "storage" | "identity";

/** Worst-to-least surprising, and independent of the language. */
const NEED_ORDER: NeedKey[] = [
  "configuration",
  "tlsCertificate",
  "storage",
  "identity",
];

/** Which of the four a needed object is, or none of them. */
function needKey(edge: { relation: { usages: Usage[] }; to: ObjectRef }) {
  return edge.relation.usages.every((use) => use.how === "ingressTls")
    ? ("tlsCertificate" as NeedKey)
    : NEED_LABEL[edge.to.kind];
}

/** Its place in the order, or last for a kind the table does not name. */
function needRank(edge: { relation: { usages: Usage[] }; to: ObjectRef }) {
  const key = needKey(edge);
  const at = key ? NEED_ORDER.indexOf(key) : -1;
  return at === -1 ? NEED_ORDER.length : at;
}

/** And what to call it — the kind's own name where the table has none. */
function needLabel(
  edge: { relation: { usages: Usage[] }; to: ObjectRef },
  t: T
): string {
  // The four live in two sections of the catalogue, so the section is part
  // of the answer rather than something a caller can guess.
  switch (needKey(edge)) {
    case "configuration":
      return t("nav", "configuration");
    case "tlsCertificate":
      return t("nav", "tlsCertificate");
    case "storage":
      return t("nav", "storage");
    case "identity":
      return t("columns", "identity");
    default:
      return edge.to.kind;
  }
}

/** Who sets a workload's replica count, as this neighbourhood can tell. */
export type ReplicaSetter =
  | { by: "autoscaler"; object: ObjectRef }
  | { by: "itself" }
  | { by: "unread" };

/** An autoscaler aimed at the workload wins; with autoscalers unread, the workload's own claim is not known. */
export function replicaSetter(
  conns: ResourceConnections,
  workload: Named
): ReplicaSetter {
  const scaler = autoscalers(conns).find((auto) =>
    sameObject(auto.target, workload)
  );
  if (scaler) return { by: "autoscaler", object: scaler.object };
  return conns.notLookedAt.some(
    (entry) => entry.kind === "HorizontalPodAutoscaler"
  )
    ? { by: "unread" }
    : { by: "itself" };
}

/**
 * Where the top of an ownership chain gets its replica count, in words:
 * shared with the Overview's own chain so the two cannot word it differently.
 */
export function replicaSetterWords(setter: ReplicaSetter, t: T): string {
  switch (setter.by) {
    case "autoscaler":
      return t("nav", "replicaCountSetBy", {
        kind: setter.object.kind,
        name: setter.object.name,
      });
    case "unread":
      return t("nav", "replicaCountSetHereUnlessScaled");
    case "itself":
      return t("nav", "replicaCountSetHere");
  }
}

const OWNABLE = new Set([
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
]);

const UNASKED_LABEL: Record<
  string,
  | "autoscaling"
  | "disruptionBudget"
  | "theServices"
  | "theIngresses"
  | "thePods"
> = {
  HorizontalPodAutoscaler: "autoscaling",
  PodDisruptionBudget: "disruptionBudget",
  Service: "theServices",
  Ingress: "theIngresses",
  Pod: "thePods",
};

/**
 * Why a kind went unread, in the reader's language.
 *
 * The backend names the reason: it decides this inside a query, where no
 * language is in scope. The cluster's own refusal rides through untouched.
 */
export function unreadWhy(why: Unread, t: T): string {
  switch (why.says) {
    case "unanswered":
      return t("readings", "unreadUnanswered", {
        version: why.version,
        said: why.said,
      });
    case "nodeClaimsNotRead":
      return t("readings", "unreadNodeClaims");
    case "volumeMountsNotRead":
      return t("readings", "unreadVolumeMounts");
    case "policiesOnTheirTab":
      return t("readings", "unreadPoliciesOnTheirTab");
    case "policiesOnPodTabs":
      return t("readings", "unreadPoliciesOnPodTabs");
  }
}

/** Policies are read on a pod's own tab, and no reference or way in depends on them. */
export const policiesElsewhere = (entry: UnexploredKind): boolean =>
  entry.why.says === "policiesOnTheirTab" ||
  entry.why.says === "policiesOnPodTabs";

const ROUTE_KINDS = [
  "HTTPRoute",
  "GRPCRoute",
  "TLSRoute",
  "TCPRoute",
  "UDPRoute",
];

/** What a group read to say it is empty, by group. */
const EMPTY_READS = {
  routed: ["Ingress", ...ROUTE_KINDS],
  answers: ["Pod"],
  reached: ["Service", "Ingress", ...ROUTE_KINDS],
  governs: [
    "HorizontalPodAutoscaler",
    "PodDisruptionBudget",
    "ReplicaSet",
    "Deployment",
  ],
} as const;

/** A group read and found empty says so; one whose reads failed stays absent, named under Not looked at. */
function orNone(
  rows: ConnRow[],
  conns: ResourceConnections,
  reads: readonly string[],
  none: () => string
): ConnRow[] {
  if (rows.length > 0) return rows;
  if (conns.notLookedAt.some((entry) => reads.includes(entry.kind))) return [];
  return [{ key: "none", label: "", object: null, detail: none(), ways: [] }];
}

/** The same, for the group that names what was never read. */
function unaskedLabel(kind: string, t: T): string {
  const key = UNASKED_LABEL[kind];
  return key ? t("nav", key) : kind;
}

/** A label is written once and left blank on the rows that repeat it. */
function labelled(rows: ConnRow[]): ConnRow[] {
  let last = "";
  return rows.map((row) => {
    const label = row.label === last ? "" : row.label;
    last = row.label;
    return { ...row, label };
  });
}

/**
 * A row for an object with nothing but its own facts to add. Existence is
 * left off deliberately: t("nav", "notChecked") is a different claim from a fact the
 * cluster stated, and the row draws it in its own tone rather than smuggling
 * it into the same string.
 */
function rowFor(
  label: string,
  object: ObjectRef,
  t: T,
  extra?: string
): ConnRow {
  const facts = object.facts;
  return {
    key: refKey(object),
    label,
    object,
    detail: join(extra, describeFacts(facts, t)),
    refused:
      facts?.kind === "workload" && facts.podsRefused !== null
        ? refusalText(facts.podsRefused, t)
        : undefined,
    ways: [],
  };
}

function needsToRun(conns: ResourceConnections, t: T): ConnRow[] {
  const rows = verb(conns.edges, "uses")
    .filter((edge) => sameObject(edge.from, conns.subject))
    .map((edge) => ({
      ...rowFor(needLabel(edge, t), edge.to, t),
      ways: describeUsages(edge.relation.usages, t),
      missingKeys: missingKeysOf(edge.relation.usages, edge.to.kind),
      verifiable: true,
      rank: needRank(edge),
    }));
  rows.sort(
    (a, b) => (a.rank ?? NEED_ORDER.length) - (b.rank ?? NEED_ORDER.length)
  );
  return labelled(rows);
}

function usedBy(conns: ResourceConnections, t: T): ConnRow[] {
  return labelled(
    verb(conns.edges, "uses")
      .filter((edge) => sameObject(edge.to, conns.subject))
      .map((edge) => ({
        ...rowFor(edge.from.kind, edge.from, t),
        ways: describeUsages(edge.relation.usages, t),
        missingKeys: missingKeysOf(edge.relation.usages, conns.subject.kind),
      }))
  );
}

/** Only a key the subject was read and found without; an unread one is not missing. */
function missingKeysOf(usages: Usage[], from: string): ConnRow["missingKeys"] {
  const missing = usages.flatMap((use) =>
    use.how === "env" && use.keyPresent === false
      ? [{ key: use.key, optional: use.optional, from }]
      : []
  );
  return missing.length > 0 ? missing : undefined;
}

/**
 * What made the pods behind an address.
 *
 * A Service states no workload. The pods it selects state their owners, and
 * the top of that chain is the thing somebody deploys — so the roots of the
 * ownership edges are the answer, and the ReplicaSet in between is noise
 * here.
 */
function answersHere(conns: ResourceConnections, t: T): ConnRow[] {
  const owns = verb(conns.edges, "owns");
  const owned = new Set(owns.map((edge) => refKey(edge.to)));
  // A workload scaled to zero owns no pod, so the backend names it outright.
  const idle = verb(conns.edges, "selects")
    .filter(
      (edge) => sameObject(edge.from, conns.subject) && edge.to.kind !== "Pod"
    )
    .map((edge) => edge.to);
  return labelled(
    unique([
      ...owns
        .map((edge) => edge.from)
        .filter(
          (from) => !owned.has(refKey(from)) && !sameObject(from, conns.subject)
        ),
      ...idle,
    ]).map((object) => rowFor(object.kind, object, t))
  );
}

/** Whether an edge sends traffic to `target`, as an Ingress rule or a Gateway API route. */
const routesInto = (edge: ConnectionEdge, target: ObjectRef) =>
  (edge.relation.verb === "routes" || edge.relation.verb === "ruleRoutes") &&
  sameObject(edge.to, target);

/** Every Ingress and route sending traffic to any of `targets`. */
function routedFrom(
  conns: ResourceConnections,
  targets: ObjectRef[]
): ObjectRef[] {
  return unique(
    conns.edges
      .filter((edge) => targets.some((target) => routesInto(edge, target)))
      .map((edge) => edge.from)
  );
}

/** The mirror of {@link answersHere}: the Services that select the subject, and what routes to them. */
function reachedThrough(conns: ResourceConnections, t: T): ConnRow[] {
  const services = verb(conns.edges, "selects")
    .filter(
      (edge) =>
        edge.from.kind === "Service" && sameObject(edge.to, conns.subject)
    )
    .map((edge) => edge.from);
  return labelled(
    unique([...services, ...routedFrom(conns, services)]).map((object) =>
      rowFor(object.kind, object, t)
    )
  );
}

/** What sends traffic to the subject Service, as its Overview and its Delete dialog name it. */
function routedHere(conns: ResourceConnections, t: T): ConnRow[] {
  return labelled(
    routedFrom(conns, [conns.subject]).map((object) =>
      rowFor(object.kind, object, t)
    )
  );
}

/**
 * Who made this, all the way up, and what it made.
 *
 * Walked rather than read one hop: a pod's owner is a hash nobody named, and
 * the object somebody actually deploys is one further up. The backend already
 * sent every hop of the chain, so this costs a loop rather than a request.
 *
 * The top of the chain carries the clause saying where the replica count is
 * set. A pod is not scalable and must not pretend to be — a Scale control
 * there would write a number to an object with no such field — but a reader
 * on a crash-looping pod is two hops from the answer and nothing else says
 * which name to open: `crash-demo-c688f57cf` is a revision that will be
 * replaced, `crash-demo` is where the number lives. It is only ever put on a
 * kind this app can actually scale, so it never points somewhere with no
 * control.
 */
function madeByAndMakes(conns: ResourceConnections, t: T): ConnRow[] {
  const owns = verb(conns.edges, "owns");
  const children = owns.filter((edge) => sameObject(edge.from, conns.subject));

  const rows: ConnRow[] = [];
  const seen = new Set<string>([refKey(conns.subject)]);
  let child = conns.subject;
  for (;;) {
    const up = owns.filter((edge) => sameObject(edge.to, child));
    if (up.length === 0) break;
    for (const edge of up) {
      rows.push({
        ...rowFor(
          t("columns", "controlledBy"),
          edge.from,
          t,
          edge.relation.controller ? undefined : t("nav", "ownerNotController")
        ),
        key: `owner:${refKey(edge.from)}`,
      });
    }
    const next = up.find((edge) => edge.relation.controller) ?? up[0];
    if (seen.has(refKey(next.from))) break;
    seen.add(refKey(next.from));
    child = next.from;
  }

  const top = rows.findIndex((row) => row.key === `owner:${refKey(child)}`);
  if (
    top !== -1 &&
    isScalable(child.kind) &&
    (child.group === undefined || isBuiltInGroup(child.kind, child.group))
  ) {
    rows[top] = {
      ...rows[top],
      detail: join(
        replicaSetterWords(replicaSetter(conns, child), t),
        rows[top].detail
      ),
    };
  }

  if (rows.length === 0) {
    rows.push({
      key: "owner:none",
      label: t("columns", "controlledBy"),
      object: null,
      detail: t("nav", "nothingIsTheTop", { kind: conns.subject.kind }),
      ways: [],
    });
  }

  const revisions = children
    .filter((edge) => edge.to.kind === "ReplicaSet")
    .sort((a, b) => revisionOf(b.to) - revisionOf(a.to));
  const rest = children.filter((edge) => edge.to.kind !== "ReplicaSet");

  for (const edge of [...revisions, ...rest]) {
    rows.push({
      ...rowFor(
        edge.to.kind === "ReplicaSet"
          ? t("nav", "revisions")
          : t("nav", "childrenRuns"),
        edge.to,
        t
      ),
      key: `child:${refKey(edge.to)}`,
    });
  }
  return labelled(rows);
}

function revisionOf(object: ObjectRef): number {
  const facts = object.facts;
  if (facts?.kind !== "workload" || facts.revision === null) return -1;
  return Number.parseInt(facts.revision, 10) || -1;
}

/**
 * Where the scheduler put it — the same edge, read from whichever end the
 * page is standing on.
 *
 * The subject's own scope decides which namespaces are read: a Node's pods
 * across all of them, never resolved to `default`, which would draw whatever
 * happened to live there as the whole answer.
 */
function placement(conns: ResourceConnections, t: T): ConnGroup | null {
  const edges = verb(conns.edges, "runsOn");
  if (edges.length === 0) return null;
  if (conns.subject.kind === "Node") return runsHere(conns, edges, t);
  return {
    key: "placement",
    title: t("nav", "runsOn"),
    caption: null,
    rows: labelled(
      unique(edges.map((edge) => edge.to)).map((object) =>
        rowFor("Node", object, t)
      )
    ),
  };
}

/**
 * The pods a node is carrying, labelled by the namespace they are in.
 *
 * The namespace is the label rather than a suffix on the name because it is
 * the thing that repeats: a node in a real cluster carries kube-system's
 * pods, an ingress controller's and the reader's own, and the grouping is
 * what turns a flat list of forty names into three answers.
 *
 * The count reads against what the scheduler will allow, because a list of
 * pods with no denominator does not answer "is this node full".
 */
function runsHere(
  conns: ResourceConnections,
  edges: ConnectionEdge[],
  t: T
): ConnGroup {
  const pods = unique(edges.map((edge) => edge.from)).sort(
    (a, b) =>
      (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
      a.name.localeCompare(b.name)
  );
  const namespaces = new Set(pods.map((pod) => pod.namespace ?? "")).size;
  const facts = conns.subject.facts;
  const capacity =
    facts?.kind === "node" && facts.podCapacity !== null
      ? `, ${t("count", "ofNodePodCapacity", { n: facts.podCapacity })}`
      : "";
  const across =
    namespaces > 1
      ? ` ${t("count", "acrossNamespaces", { n: namespaces })}`
      : "";
  const tally = `${t("count", "pods", { n: pods.length })}${across}${capacity}`;
  return {
    key: "placed",
    title: t("nav", "whatRunsHere"),
    caption: join(
      tally,
      facts?.kind === "node" ? nodeCapacity(facts, t) : null
    ),
    rows: labelled(
      pods.map((pod) =>
        rowFor(pod.namespace ?? t("nav", "noNamespaceValue"), pod, t)
      )
    ),
  };
}

/**
 * What acts on this object without it having asked, and without it knowing.
 *
 * Its own group rather than rows in "Made by, and makes", and the difference
 * is the tense: that group answers *what made this*, a settled fact about the
 * past, while these two are about what happens next — a replica count that
 * moves back in fifteen seconds, an eviction that gets refused.
 *
 * Nor does it merge with "Needs to run", whose claim is "if one of these is
 * missing the pod does not start": the workload runs perfectly well without
 * an autoscaler, and has no say in it either way.
 */
function governedBy(conns: ResourceConnections, t: T): ConnRow[] {
  const rows = verb(conns.edges, "governs").map((edge) => ({
    ...rowFor(governorLabel(edge.from.kind, t), edge.from, t),
    key: `governs:${refKey(edge.from)}:${refKey(edge.to)}`,
    ways: [
      // Named where the far end is not the page's own subject — on a pod, an
      // autoscaler scales the Deployment above it, and saying "scales this"
      // there would be wrong about which object the number belongs to.
      ...(sameObject(edge.to, conns.subject)
        ? []
        : [
            `${t("nav", GOVERNS_VERB[edge.from.kind] ?? "actsOn")} ${edge.to.kind} ${edge.to.name}`,
          ]),
      // And which query reached it. A budget names no workload — it matched
      // labels — so "why does this apply to me" is otherwise unanswerable
      // from the page it applies to. An autoscaler states its target
      // outright and carries no selector to print.
      ...(edge.relation.selector
        ? [t("nav", "selectsLabels", { selector: edge.relation.selector })]
        : []),
    ],
  }));
  return labelled(rows);
}

const GOVERNOR_LABEL: Record<string, "autoscaling" | "disruptionBudget"> = {
  HorizontalPodAutoscaler: "autoscaling",
  PodDisruptionBudget: "disruptionBudget",
};

/** What governs this, in words — the kind's own name where there are none. */
function governorLabel(kind: string, t: T): string {
  const key = GOVERNOR_LABEL[kind];
  return key ? t("nav", key) : kind;
}

const GOVERNS_VERB: Record<string, "scalesVerb" | "protectsVerb"> = {
  HorizontalPodAutoscaler: "scalesVerb",
  PodDisruptionBudget: "protectsVerb",
};

function bindings(conns: ResourceConnections, t: T): ConnRow[] {
  return labelled(
    verb(conns.edges, "binds").map((edge) =>
      rowFor(
        edge.to.kind === "StorageClass"
          ? t("columns", "storageClass")
          : t("columns", "volume"),
        edge.to,
        t
      )
    )
  );
}

/**
 * Every group this object has, in the order the questions get asked.
 */
export function connectionGroups(
  conns: ResourceConnections,
  t: T,
  /**
   * What delivered the subject, where anything did.
   *
   * Passed in rather than fetched here for the reason the whole module is
   * pure: the edges come from one backend call and the provenance from a
   * capability that may not be installed, and the grouping must not learn
   * how either of them is fetched.
   */
  delivery: Delivery[] = []
): ConnGroup[] {
  const deliveredBy = deliveredRows(delivery, t);
  const where = t("empty", "inNamespaceWhere", {
    namespace: conns.subject.namespace ?? "",
  });
  const selects =
    conns.subject.facts?.kind !== "service" || !!conns.subject.facts.selector;
  const groups: (ConnGroup | null)[] = [
    {
      key: "needs",
      title: t("nav", "needsToRun"),
      caption: t("nav", "needsToRunNote"),
      rows: needsToRun(conns, t),
    },
    {
      key: "used-by",
      title: t("nav", "usedBy"),
      caption: t("nav", "usedByNote"),
      rows: usedBy(conns, t),
    },
    conns.subject.kind === "Service"
      ? {
          key: "routed",
          title: t("nav", "reachedThrough"),
          caption: t("nav", "routedHereNote"),
          rows: orNone(routedHere(conns, t), conns, EMPTY_READS.routed, () =>
            t("nav", "noneRoutesHere", { where })
          ),
        }
      : null,
    conns.subject.kind === "Service" || conns.subject.kind === "Ingress"
      ? {
          key: "answers",
          title: t("nav", "whatAnswersHere"),
          caption: t("nav", "whatAnswersHereNote"),
          rows:
            conns.subject.kind === "Service" && selects
              ? orNone(answersHere(conns, t), conns, EMPTY_READS.answers, () =>
                  t("nav", "noPodAnswers", { where })
                )
              : answersHere(conns, t),
        }
      : null,
    OWNABLE.has(conns.subject.kind)
      ? {
          key: "reached",
          title: t("nav", "reachedThrough"),
          caption: t("nav", "reachedThroughNote"),
          rows: orNone(
            reachedThrough(conns, t),
            conns,
            EMPTY_READS.reached,
            () => t("nav", "noneReachesPods", { where })
          ),
        }
      : null,
    placement(conns, t),
    {
      key: "binds",
      title: t("nav", "boundTo"),
      caption: null,
      rows: bindings(conns, t),
    },
    {
      key: "governs",
      title: t("nav", "governedBy"),
      caption: t("nav", "governedByNote"),
      rows: OWNABLE.has(conns.subject.kind)
        ? orNone(governedBy(conns, t), conns, EMPTY_READS.governs, () =>
            t("nav", "noneGoverns", { where })
          )
        : governedBy(conns, t),
    },
    // The kinds that take part in ownership, plus any delivered object
    // whatever its kind: "Controlled by: nothing" is a real answer on a
    // Deployment and a non-sequitur on a ConfigMap, but a ConfigMap applied
    // from a repository was still *made* by something.
    OWNABLE.has(conns.subject.kind) || deliveredBy.length > 0
      ? {
          key: "owners",
          title: t("nav", "madeByAndMakes"),
          caption: null,
          rows: [
            ...deliveredBy,
            ...(OWNABLE.has(conns.subject.kind)
              ? madeByAndMakes(conns, t)
              : []),
          ],
        }
      : null,
  ];

  const drawn = groups.filter(
    (group): group is ConnGroup => group !== null && group.rows.length > 0
  );

  if (conns.notLookedAt.length > 0) {
    drawn.push({
      key: "unasked",
      title: t("nav", "notLookedAt"),
      caption: t("nav", "notLookedAtNote"),
      rows: conns.notLookedAt.map((entry) => ({
        key: entry.kind,
        label: unaskedLabel(entry.kind, t),
        object: null,
        detail: unreadWhy(entry.why, t),
        ways: [],
        unasked: true,
      })),
    });
  }

  return drawn;
}

/**
 * The `delivers` edge, whose far end is out of the cluster.
 *
 * Only a *confirmed* delivery earns a structural edge. A label nothing
 * honours is a claim about provenance and is said as one, on the Overview —
 * drawing it here would put a line in the connection graph for a relationship
 * that does not exist.
 */
function deliveredRows(delivery: Delivery[], t: T): ConnRow[] {
  return labelled(
    delivered(delivery).map((source) => ({
      key: `delivered:${source.vendorId}:${source.owner.namespace}/${source.owner.name}`,
      label: t("nav", "deliveredBy"),
      object: null,
      outside: {
        name: source.owner.name,
        to: source.owner.to,
        revision: source.revision,
        link: source.repoUrl
          ? gitRevisionLink(source.repoUrl, source.revision)
          : null,
      },
      detail: [
        `${source.vendor} ${source.owner.kind}`,
        source.path
          ? t("nav", "deliveredFromPath", { path: source.path })
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      ways: [],
    }))
  );
}

/** An object deleting the subject leaves behind, still naming it, and how. */
export interface Dependent {
  object: ObjectRef;
  ways: string[];
}

/**
 * What names the subject and is not deleted with it: an Ingress or a route
 * sending traffic to it, a pod or workload reading it, a route attached to
 * it, a claim bound to it, an autoscaler aimed at it. Ownership is the
 * cascade's question; a selector names no object.
 */
export function dependentsOf(conns: ResourceConnections, t: T): Dependent[] {
  const found = new Map<string, Dependent>();
  for (const edge of conns.edges) {
    if (!sameObject(edge.to, conns.subject)) continue;
    if (sameObject(edge.from, conns.subject)) continue;
    const ways = dependentWays(edge, t);
    if (!ways) continue;
    const key = refKey(edge.from);
    const known = found.get(key);
    if (known) known.ways = [...new Set([...known.ways, ...ways])];
    else found.set(key, { object: edge.from, ways });
  }
  return [...found.values()];
}

function dependentWays(edge: ConnectionEdge, t: T): string[] | null {
  const relation = edge.relation;
  switch (relation.verb) {
    case "routes":
      return [`${relation.host ?? "*"}${relation.path}`];
    case "ruleRoutes":
      return [relation.hostnames.join(", ") || "*"];
    case "uses":
      return describeUsages(relation.usages, t);
    case "attachesTo":
    case "binds":
      return [];
    case "governs":
      return edge.from.kind === "HorizontalPodAutoscaler" ? [] : null;
    case "owns":
    case "selects":
    case "runsOn":
      return null;
  }
}

/**
 * A translator for the one caller that provably throws every word away.
 *
 * {@link connectionCount} reads `row.object` and nothing else, so the number
 * cannot depend on the language, and threading a translator through the ten
 * pages that ask for the count would be a parameter that exists to be
 * discarded.
 */
const NO_WORDS: T = () => "";

/** How many distinct objects the tab draws — what its count mark stands for. */
export function connectionCount(conns: ResourceConnections): number {
  return unique(
    connectionGroups(conns, NO_WORDS)
      .flatMap((group) => group.rows)
      .map((row) => row.object)
      .filter((object): object is ObjectRef => object !== null)
  ).length;
}
