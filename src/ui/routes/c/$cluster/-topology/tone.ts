/**
 * A map node's colour, by the function its own page colours it with. The
 * backend sends each node the input that page reads; this is the one place
 * those inputs become a tone, and the table is total over every verdict.
 */

import type { IngressInfo, NodeVerdict, TopologyNode } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { MapTone } from "@/integrations";
import { stopTone, type HopTone } from "@/lib/connections";
import { autoscalerVerdict, budgetFinding } from "@/lib/governance";
import type { IngressHealth } from "@/lib/ingress-health";
import { ingressHealthWords } from "@/lib/ingress-health";
import { programmedWord } from "@/lib/route-trace";
import { serviceHealthOf, serviceHealthWords } from "@/lib/service-health";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { workloadRole } from "@/lib/workload-status";
import type { MapVerdicts } from "./route-verdicts";

/** A page's role as the map's tone: a role nobody rates is quiet, never green. */
export const ROLE_TONE: Record<StatusRole, MapTone> = {
  ok: "ok",
  pending: "mute",
  warn: "warn",
  err: "err",
  neutral: "mute",
};

const HOP_TONE: Record<HopTone, MapTone> = {
  on: "ok",
  info: "mute",
  unknown: "unknown",
  warn: "warn",
  bad: "err",
};

const FINDING_TONE = { err: "err", warn: "warn", neutral: "mute" } as const;

/** Which of several tones a group or an edge folded from them shows. */
export const LOUDNESS: Record<MapTone, number> = {
  err: 4,
  warn: 3,
  unknown: 2,
  ok: 1,
  mute: 0,
};

export const loudest = (tones: Iterable<MapTone>, quiet: MapTone = "mute") => {
  let held = quiet;
  for (const tone of tones) if (LOUDNESS[tone] > LOUDNESS[held]) held = tone;
  return held;
};

export interface ToneInputs {
  t: T;
  /** An Ingress's verdict by the Ingresses list's own hook; `null` until it has one. */
  ingress: (row: IngressInfo) => IngressHealth | null;
  /** Kinds whose read broke: what is drawn of them is from then. */
  stale: ReadonlySet<string>;
  /**
   * The Routes and Gateways pages' verdicts, which a route and a Gateway take
   * their tone from where they are given: without them, a route whose own
   * status says Accepted is all the map can read, and that vouches for
   * nothing past its parent.
   */
  verdicts?: MapVerdicts;
}

type Says = NodeVerdict["says"];
type Toner = {
  [S in Says]: (
    verdict: Extract<NodeVerdict, { says: S }>,
    node: TopologyNode,
    inputs: ToneInputs
  ) => MapTone;
};

/** The Service's verdict as its page reads it from what it publishes. */
export function serviceHealthOfNode(
  node: TopologyNode,
  verdict: Extract<NodeVerdict, { says: "service" }>
) {
  const facts = node.ref.facts;
  const shape =
    facts?.kind === "service"
      ? { type: facts.type, selectorless: facts.selector === null }
      : { type: "", selectorless: false };
  return serviceHealthOf(
    shape,
    verdict.published ?? undefined,
    verdict.published ? null : verdict.unread
  );
}

const TONE_OF: Toner = {
  rollout: ({ rollout }) =>
    rollout.state === "podsUnread"
      ? "unknown"
      : ROLE_TONE[workloadRole(rollout)],
  job: ({ status }) => ROLE_TONE[statusRole(status)],
  cronJob: ({ suspend }) =>
    ROLE_TONE[statusRole(suspend ? "Suspended" : "Active")],
  replicas: () => "mute",
  service: (verdict, node, { t }) => {
    const health = serviceHealthOfNode(node, verdict);
    return health.state === "unknown"
      ? "unknown"
      : ROLE_TONE[serviceHealthWords(health, t).role];
  },
  ingress: ({ row }, _node, { ingress, t }) => {
    const health = ingress(row);
    return health ? ROLE_TONE[ingressHealthWords(health, t).role] : "unknown";
  },
  route: ({ stops, accepted }, node, { verdicts }) => {
    const page = verdicts?.route({
      kind: node.ref.kind,
      name: node.ref.name,
      namespace: node.ref.namespace ?? "",
    });
    if (page) return page.tone;
    const own =
      stops.length > 0
        ? loudest(stops.map((stop) => HOP_TONE[stopTone(stop)]))
        : accepted === null
          ? "unknown"
          : accepted
            ? "ok"
            : "err";
    return verdicts && own === "ok" ? "unknown" : own;
  },
  gateway: ({ row }, _node, { t, verdicts }) =>
    verdicts?.gateway(row.namespace, row.name)?.tone ??
    ROLE_TONE[programmedWord(row, t).role],
  claim: ({ phase }) =>
    phase === null ? "unknown" : ROLE_TONE[statusRole(phase)],
  autoscaler: (_verdict, node) => {
    const facts = node.ref.facts;
    if (facts?.kind !== "autoscaler") return "unknown";
    const verdict = autoscalerVerdict(facts);
    return verdict ? FINDING_TONE[verdict.tone] : "ok";
  },
  budget: (_verdict, node, { t }) => {
    const facts = node.ref.facts;
    if (facts?.kind !== "budget") return "unknown";
    const finding = budgetFinding(node.ref.name, facts, t);
    return finding ? FINDING_TONE[finding.tone] : "ok";
  },
  policy: ({ selected }) =>
    selected === null ? "unknown" : selected === 0 ? "warn" : "mute",
  exists: () => "mute",
  owner: () => "unknown",
  // As the Pods list paints each, and a running pod that is not ready is not
  // the green its status alone would earn.
  ownerless: ({ statuses }) =>
    loudest(
      statuses.map(({ status, total, ready }) =>
        status === "Running" && ready < total
          ? "warn"
          : ROLE_TONE[statusRole(status)]
      )
    ),
};

/**
 * The kinds besides its own each verdict is worked out from: a Service's
 * serving from its slices and pods, a workload's rollout from its pods. A
 * read of one gone stale leaves the verdict as of then.
 */
const READ_FROM: Record<Says, readonly string[]> = {
  rollout: ["Pod"],
  job: [],
  cronJob: [],
  replicas: [],
  service: ["EndpointSlice", "Pod"],
  ingress: [],
  route: ["Gateway", "ListenerSet"],
  gateway: ["ListenerSet"],
  claim: [],
  autoscaler: [],
  budget: [],
  policy: ["Pod"],
  exists: [],
  owner: [],
  ownerless: ["Pod"],
};

/**
 * The node's tone. What was not read is unknown before anything else: a
 * green node for an object nobody could look at is the lie the words would
 * have been, and so is one coloured from a read that went stale.
 */
export function toneOf(node: TopologyNode, inputs: ToneInputs): MapTone {
  if (node.ref.existence === "notChecked") return "unknown";
  if (node.ref.existence === "missing") return "err";
  if (
    inputs.stale.has(node.ref.kind) ||
    READ_FROM[node.verdict.says].some((kind) => inputs.stale.has(kind))
  )
    return "unknown";
  const toner = TONE_OF[node.verdict.says] as (
    verdict: NodeVerdict,
    node: TopologyNode,
    inputs: ToneInputs
  ) => MapTone;
  return toner(node.verdict, node, inputs);
}
