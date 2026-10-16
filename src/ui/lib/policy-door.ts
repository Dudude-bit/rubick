/**
 * Whether the pods an ingress controller connects from get through the
 * NetworkPolicies on both ends: the ones over a Service's pods, and the
 * egress rules over the controller's own pods.
 *
 * Which policies fall on the Service's pods is settled in Rust from its
 * selector and shipped as `door`; who a rule's peer names is `peerMatch`,
 * the same reading the policy pages use. This joins the two for one client
 * and says "refused" only where no rule could let any of its pods through.
 */

import type {
  ChainStop,
  DoorPort,
  DoorRule,
  NetworkPolicyInfo,
  ObjectRef,
  PolicyIpBlock,
  PolicyPeer,
  PolicyPort,
  PolicyRule,
  RefusedClient,
  Scoped,
  ServicePublished,
} from "@/generated/types";
import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { cidrOverlap, inCidr } from "@/lib/cidr";
import type { Known } from "@/lib/known";
import {
  peerMatch,
  podPolicies,
  type LabeledNamespace,
  type LabeledPod,
  type PolicyRows,
} from "@/lib/policy-peers";

/** A pod a controller connects to its backends from. */
export interface DoorClient extends LabeledPod {
  /** The address its connections leave from, where it was read. */
  ip: string | null;
  /** On the node's network, so a policy sees the node rather than a pod. */
  hostNetwork: boolean;
}

/** A vendor's claim to a controller, and how to read the pods it connects from. */
export interface DoorClaim {
  name: string;
  read: () => Promise<DoorClient[]>;
}

/** One controller's pods and the namespaces a peer may name, as read. */
export interface DoorRead {
  name: string;
  clients: Known<DoorClient[]>;
  namespaces: Known<LabeledNamespace[]>;
  /** The NetworkPolicies in the namespaces its pods run in, whose egress rules say where they may connect. */
  egress: Known<Scoped<NetworkPolicyInfo>>;
}

/** A controller's read: `null` where no integration speaks for it, `undefined` while asking. */
export interface DoorAsk {
  (controller: string): DoorRead | null | undefined;
  /** The controller a GatewayClass names, where the classes were read. */
  classController?: (gatewayClass: string) => string | undefined;
}

export type DoorUnsure =
  | "policiesUnread"
  | "noPort"
  | "noIntegration"
  | "clientsReading"
  | "clientsUnread"
  | "noClients"
  | "namespacesUnread"
  | "hostNetwork"
  | "byName"
  | "unsettled"
  | "someClients"
  | "ipBlock"
  | "unevaluable"
  | "egressUnread"
  | "egressByPods"
  | "egressIpBlock";

/** The end of the connection a policy holds: the Service's pods, or the controller's own. */
export type DoorSide = "pods" | "client";

export type PolicyStop = Extract<
  ChainStop,
  { reason: "policyRefuses" | "policyHoldsBack" }
>;

/** A stop a NetworkPolicy makes: the pods are there, and a connection to them is not let through. */
export const isPolicyStop = (
  stop: ChainStop | null | undefined
): stop is PolicyStop =>
  stop?.reason === "policyRefuses" || stop?.reason === "policyHoldsBack";

/** The NetworkPolicies a policy stop names. */
export const policyNamesOf = (stop: PolicyStop): string[] =>
  stop.reason === "policyRefuses"
    ? stop.policies
    : stop.policies.map((policy) => policy.name);

/** What the verdict reads of a Service: its door, the ports and addresses its pods take connections on, and the stop already said about it. */
export type DoorSubject = Pick<ServicePublished, "service" | "door" | "ports"> &
  Partial<Pick<ServicePublished, "endpoints">> & {
    stop?: ChainStop | null;
    /** The networks its pods sit in, where those came instead of the addresses. */
    networks?: string[];
  };

export type DoorVerdict =
  /** No policy holds either end, or the path's stop has said it already. */
  | { state: "open" }
  | { state: "admitted" }
  | { state: "refused"; stop: PolicyStop }
  | {
      state: "unsure";
      policies: string[];
      why: DoorUnsure;
      side: DoorSide;
      /** What the cluster answered where it refused to list the policies. */
      said: string | null;
    };

type Answer = boolean | DoorUnsure;

const OPEN: DoorVerdict = { state: "open" };

/** The door port an Ingress backend's `port` (a number or a name) sends to. */
export function doorPortOf(
  ports: DoorPort[],
  backend: string | null
): DoorPort | null {
  if (backend === null || backend === "")
    return ports.length === 1 ? ports[0] : null;
  const number = /^\d+$/.test(backend) ? Number(backend) : null;
  return (
    ports.find((port) =>
      number === null ? port.name === backend : port.servicePort === number
    ) ?? null
  );
}

/** The first answer that lets it through, else the first doubt. */
function anyOf<I>(items: I[], answer: (item: I) => Answer): Answer {
  let doubt: DoorUnsure | null = null;
  for (const item of items) {
    const found = answer(item);
    if (found === true) return true;
    if (found !== false) doubt ??= found;
  }
  return doubt ?? false;
}

const both = (a: Answer, b: Answer): Answer =>
  a === false || b === false ? false : a === true ? b : a;

/** Whether an ipBlock holds `ip`; `null` where a CIDR could not be read. */
function blockHolds(block: PolicyIpBlock, ip: string): boolean | null {
  const inside = inCidr(ip, block.cidr);
  const except = block.except.map((cidr) => inCidr(ip, cidr));
  if (inside === null || except.includes(null)) return null;
  return inside && !except.includes(true);
}

function peerAdmits(
  peer: PolicyPeer,
  client: DoorClient,
  home: string,
  namespaces: Known<LabeledNamespace[]>
): Answer {
  if (client.hostNetwork) return "hostNetwork";
  if (peer.ipBlock) {
    if (client.ip === null) return "clientsUnread";
    const holds = blockHolds(peer.ipBlock, client.ip);
    if (holds === null) return "unevaluable";
    // Whether an ipBlock applies to traffic from a pod is the network plugin's choice.
    return holds ? "ipBlock" : false;
  }
  const match = peerMatch(
    peer,
    home,
    { known: true, value: [client] },
    namespaces
  );
  switch (match.kind) {
    case "matched":
      return match.pods.length > 0;
    case "cannotSay":
      return "namespacesUnread";
    case "unevaluable":
    case "ipBlock":
      return "unevaluable";
  }
}

function clientAdmitted(
  port: DoorPort,
  unsettled: string[],
  client: DoorClient,
  home: string,
  namespaces: Known<LabeledNamespace[]>
): Answer {
  return anyOf(port.rules, (rule: DoorRule) => {
    const answer =
      rule.peers.length === 0
        ? true
        : anyOf(rule.peers, (peer) =>
            peerAdmits(peer, client, home, namespaces)
          );
    if (answer !== true) return answer;
    if (rule.byName) return "byName";
    return unsettled.includes(rule.policy) ? "unsettled" : true;
  });
}

/** Every client through, none, or some: the verdict over all of a controller's pods. */
function settle(answers: Answer[]): "all" | "none" | DoorUnsure {
  const doubt = answers.find(
    (answer): answer is DoorUnsure => typeof answer === "string"
  );
  if (doubt) return doubt;
  if (answers.every((answer) => answer === true)) return "all";
  return answers.some((answer) => answer === true) ? "someClients" : "none";
}

const clientOf = (name: string, clients: DoorClient[]): RefusedClient => ({
  name,
  namespaces: [...new Set(clients.map((client) => client.namespace))].sort(),
});

/** Whether the policies over the Service's pods let the controller in. */
function podsVerdict(
  published: DoorSubject,
  port: DoorPort | null,
  read: DoorRead | null | undefined
): DoorVerdict {
  const door = published.door;
  const unsure = (
    why: DoorUnsure,
    policies: string[] = [],
    said: string | null = null
  ): DoorVerdict => ({ state: "unsure", policies, why, side: "pods", said });
  if (!door || door.state === "unread")
    return unsure("policiesUnread", [], door?.reason ?? null);
  if (door.state === "open" || door.isolating.length === 0) return OPEN;
  const policies = [...door.isolating, ...door.unsettled];
  if (!port) return unsure("noPort", policies);
  if (read === null) return unsure("noIntegration", policies);
  if (read === undefined) return unsure("clientsReading", policies);
  const { clients, namespaces } = read;
  if (!clients.known)
    return unsure(
      clients.why === null ? "clientsReading" : "clientsUnread",
      policies
    );
  if (clients.value.length === 0) return unsure("noClients", policies);
  const home = published.service.namespace ?? "";
  const outcome = settle(
    clients.value.map((client) =>
      clientAdmitted(port, door.unsettled, client, home, namespaces)
    )
  );
  if (outcome === "all") return { state: "admitted" };
  if (outcome !== "none") return unsure(outcome, policies);
  return {
    state: "refused",
    stop: {
      reason: "policyRefuses",
      service: published.service,
      policies: door.isolating,
      ports: port.port === null ? [] : [port.port],
      noRules: false,
      client: clientOf(read.name, clients.value),
    },
  };
}

/** Where a connection lands: the Service's pods, by namespace and the networks they sit in. */
interface Landing {
  namespace: string;
  /** `null` where neither addresses nor networks came with the subject. */
  networks: string[] | null;
}

function blockLets(block: PolicyIpBlock, networks: string[] | null): Answer {
  if (networks === null || networks.length === 0) return "egressIpBlock";
  let lets = false;
  for (const network of networks) {
    const inside = cidrOverlap(network, block.cidr);
    const except = block.except.map((cidr) => cidrOverlap(network, cidr));
    if (inside === null || except.includes(null)) return "unevaluable";
    if (inside !== "outside" && !except.includes("within")) lets = true;
  }
  return lets ? "egressIpBlock" : false;
}

/** Whether a peer of an egress rule names the namespace the pods are in; one that also picks pods by label is not compared. */
function egressPeerLets(
  peer: PolicyPeer,
  home: string,
  to: Landing,
  namespaces: Known<LabeledNamespace[]>
): Answer {
  if (peer.ipBlock) return blockLets(peer.ipBlock, to.networks);
  const match = peerMatch(
    { ...peer, pods: { kind: "everything" } },
    home,
    { known: true, value: [{ name: "", namespace: to.namespace, labels: {} }] },
    namespaces
  );
  switch (match.kind) {
    case "matched":
      if (match.pods.length === 0) return false;
      return peer.pods.kind === "written" ? "egressByPods" : true;
    case "cannotSay":
      return "namespacesUnread";
    case "unevaluable":
    case "ipBlock":
      return "unevaluable";
  }
}

/** Whether a rule's ports let a TCP connection to `target` out. */
function portLets(ports: PolicyPort[], target: number): Answer {
  if (ports.length === 0) return true;
  return anyOf(ports, (port) => {
    if (port.protocol !== "TCP") return false;
    if (port.port === null) return true;
    if (!/^\d+$/.test(port.port)) return "byName";
    const from = Number(port.port);
    return port.endPort === null
      ? from === target
      : from <= target && target <= port.endPort;
  });
}

function egressRuleLets(
  rule: PolicyRule,
  home: string,
  to: Landing,
  target: number,
  namespaces: Known<LabeledNamespace[]>
): Answer {
  const peers =
    rule.peers.length === 0
      ? true
      : anyOf(rule.peers, (peer) => egressPeerLets(peer, home, to, namespaces));
  return both(peers, portLets(rule.ports, target));
}

/** The TCP ports a backend's connections land on: the one its port names, else every one the Service publishes. */
function targetsOf(published: DoorSubject, backend: string | null): number[] {
  const tcp = published.ports.filter((port) => port.protocol === "TCP");
  const named =
    backend !== null && !/^\d+$/.test(backend)
      ? tcp.filter((port) => port.name === backend)
      : [];
  const ports = (named.length > 0 ? named : tcp).flatMap((port) =>
    port.port === null ? [] : [port.port]
  );
  return [...new Set(ports)].sort((a, b) => a - b);
}

const policyRef = (policy: NetworkPolicyInfo): ObjectRef => ({
  kind: "NetworkPolicy",
  name: policy.name,
  namespace: policy.namespace,
  existence: "present",
  facts: null,
});

/**
 * Whether the egress rules over the controller's own pods let it reach the
 * Service's pods. Unsure with nothing to name, which no reader draws, until
 * its pods and the policies over them are read.
 */
function clientVerdict(
  published: DoorSubject,
  targets: number[],
  read: DoorRead | null | undefined
): DoorVerdict {
  if (read === null) return OPEN;
  const unsure = (
    why: DoorUnsure,
    policies: string[] = [],
    said: string | null = null
  ): DoorVerdict => ({ state: "unsure", policies, why, side: "client", said });
  if (read === undefined) return unsure("clientsReading");
  const { clients, egress, namespaces } = read;
  if (!clients.known)
    return unsure(clients.why === null ? "clientsReading" : "clientsUnread");
  if (clients.value.length === 0) return unsure("noClients");
  if (!egress.known)
    return egress.why === null
      ? unsure("clientsReading")
      : unsure("egressUnread", [], egress.why);
  const refused = egress.value.unread.find((entry) =>
    clients.value.some((client) => client.namespace === entry.namespace)
  );
  if (refused) return unsure("egressUnread", [], refused.message);

  const to: Landing = {
    namespace: published.service.namespace ?? "",
    networks:
      published.networks ??
      published.endpoints?.flatMap(({ address }) =>
        address === null
          ? []
          : [`${address}/${address.includes(":") ? 128 : 32}`]
      ) ??
      null,
  };
  const rows: PolicyRows = {
    known: true,
    value: { rows: egress.value.rows, unreadHere: null },
  };
  const holding = new Map<string, NetworkPolicyInfo>();
  const hold = (policies: NetworkPolicyInfo[]) => {
    for (const policy of policies)
      holding.set(`${policy.namespace}/${policy.name}`, policy);
  };
  const outcome = settle(
    clients.value.map((client): Answer => {
      const over = podPolicies(client, rows);
      if (over.egress.state === "open") return true;
      if (over.egress.state === "cannotSay") {
        hold(over.undecided);
        return "unevaluable";
      }
      hold(over.egress.by);
      if (client.hostNetwork) return "hostNetwork";
      if (targets.length === 0) return "noPort";
      const rules = over.egress.by.flatMap((policy) =>
        policy.egress.rules.map((rule) => ({ rule, home: policy.namespace }))
      );
      const each = targets.map((target) =>
        anyOf(rules, ({ rule, home }) =>
          egressRuleLets(rule, home, to, target, namespaces)
        )
      );
      const doubt = each.find(
        (answer): answer is DoorUnsure => typeof answer === "string"
      );
      if (doubt) return doubt;
      if (each.every((answer) => answer === true)) return true;
      return each.every((answer) => answer === false) ? false : "noPort";
    })
  );
  const policies = [...holding.values()];
  if (outcome === "all")
    return policies.length === 0 ? OPEN : { state: "admitted" };
  if (outcome !== "none")
    return unsure(
      outcome,
      policies.map((policy) => policy.name)
    );
  return {
    state: "refused",
    stop: {
      reason: "policyHoldsBack",
      service: published.service,
      client: clientOf(read.name, clients.value),
      policies: policies.map(policyRef),
      ports: targets,
    },
  };
}

/**
 * Whether a controller may connect to the pods behind `published` on
 * `backend`. A refusal at either end is the answer, the pods' end first;
 * then a doubt either end can name, the pods' end first.
 */
export function doorVerdict(
  published: DoorSubject,
  backend: string | null,
  read: DoorRead | null | undefined
): DoorVerdict {
  if (isPolicyStop(published.stop)) return OPEN;
  const door = published.door;
  const port =
    door?.state === "guarded" ? doorPortOf(door.ports, backend) : null;
  const pods = podsVerdict(published, port, read);
  if (pods.state === "refused") return pods;
  const client = clientVerdict(
    published,
    port && port.port !== null ? [port.port] : targetsOf(published, backend),
    read
  );
  if (client.state === "refused") return client;
  const doubts = [pods, client].filter((side) => side.state === "unsure");
  if (doubts.length > 0) return doubts.find(nameable) ?? doubts[0];
  return pods.state === "open" && client.state === "open"
    ? OPEN
    : { state: "admitted" };
}

/** A doubt a reader can draw: it names the policies, or quotes the cluster's refusal. */
const nameable = (verdict: DoorVerdict) =>
  verdict.state === "unsure" &&
  (verdict.policies.length > 0 || verdict.said !== null);

/** The stop a refusal of this controller puts on the path, if it is refused. */
export function refusedStop(
  published: DoorSubject | undefined,
  backend: string | null,
  read: DoorRead | null | undefined
): PolicyStop | null {
  if (!published || published.stop) return null;
  const verdict = doorVerdict(published, backend, read);
  return verdict.state === "refused" ? verdict.stop : null;
}

/** A controller's way to pods that NetworkPolicies guard, where no answer was reached. */
export interface DoorDoubt {
  policies: string[];
  why: DoorUnsure;
  side: DoorSide;
  client: string;
  /** What the cluster answered where it refused to list the policies. */
  said: string | null;
}

/** Why `client` may or may not get through, where policies guard either end and nothing settled it. */
export function doorDoubt(
  published: DoorSubject | undefined,
  backend: string | null,
  read: DoorRead | null | undefined,
  client: string
): DoorDoubt | null {
  if (!published || published.stop) return null;
  const verdict = doorVerdict(published, backend, read);
  return verdict.state === "unsure" && nameable(verdict)
    ? {
        policies: verdict.policies,
        why: verdict.why,
        side: verdict.side,
        client: read?.name ?? client,
        said: verdict.said,
      }
    : null;
}

const DOOR_WHY: Record<DoorUnsure, keyof typeof en.nav> = {
  policiesUnread: "doorWhyPoliciesUnread",
  noPort: "doorWhyNoPort",
  noIntegration: "doorWhyNoIntegration",
  clientsReading: "doorWhyClientsReading",
  clientsUnread: "doorWhyClientsUnread",
  noClients: "doorWhyNoClients",
  namespacesUnread: "doorWhyNamespacesUnread",
  hostNetwork: "doorWhyHostNetwork",
  byName: "doorWhyByName",
  unsettled: "doorWhyUnsettled",
  someClients: "doorWhySomeClients",
  ipBlock: "doorWhyIpBlock",
  unevaluable: "doorWhyUnevaluable",
  egressUnread: "doorWhyEgressUnread",
  egressByPods: "doorWhyEgressByPods",
  egressIpBlock: "doorWhyEgressIpBlock",
};

/** Why nobody settled it: the cluster's refusal where it gave one, else the reader's words. */
export const doorWhy = (doubt: DoorDoubt, t: T) =>
  doubt.said || t("nav", DOOR_WHY[doubt.why]);

/** A doubt at the controller's end, in the words every reader draws it with. */
function clientDoubtTitle(doubt: DoorDoubt, t: T, behind?: string): string {
  const n = doubt.policies.length;
  const names = doubt.policies.join(", ");
  const client = doubt.client;
  if (n === 0) return t("nav", "doorEgressUnread", { client });
  return behind === undefined
    ? t("count", "doorEgressDecides", { n, names, client })
    : t("count", "doorEgressDecidesFor", { n, names, client, service: behind });
}

/** A doubt in the words every reader draws it with; `behind` names the Service where nothing nearby does. */
export function doorDoubtWords(
  doubt: DoorDoubt,
  t: T,
  behind?: string
): { title: string; note: string } {
  const n = doubt.policies.length;
  const names = doubt.policies.join(", ");
  const note = t("nav", "doorUnsureNote", {
    client: doubt.client,
    why: doorWhy(doubt, t),
  });
  if (doubt.side === "client")
    return { title: clientDoubtTitle(doubt, t, behind), note };
  return {
    title:
      n === 0
        ? behind === undefined
          ? t("nav", "doorPoliciesUnread")
          : t("nav", "doorPoliciesUnreadFor", { service: behind })
        : behind === undefined
          ? t("count", "doorDecides", { n, names })
          : t("count", "doorDecidesFor", { n, names, service: behind }),
    note,
  };
}
