/**
 * Whether the pods an ingress controller connects from get through the
 * NetworkPolicies over a Service's pods.
 *
 * Which policies fall on the pods is settled in Rust from the Service's
 * selector and shipped as `door`; who a rule's peer names is `peerMatch`,
 * the same reading the policy pages use. This joins the two for one client
 * and says "refused" only where no rule could admit any of its pods.
 */

import type {
  ChainStop,
  DoorPort,
  DoorRule,
  PolicyPeer,
  ServicePublished,
} from "@/generated/types";
import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import { inCidr } from "@/lib/cidr";
import type { Known } from "@/lib/known";
import {
  peerMatch,
  type LabeledNamespace,
  type LabeledPod,
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
}

/** A controller's read: `null` where no integration speaks for it, `undefined` while asking. */
export type DoorAsk = (controller: string) => DoorRead | null | undefined;

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
  | "unevaluable";

export type PolicyStop = Extract<ChainStop, { reason: "policyRefuses" }>;

/** What the verdict reads of a Service: its door, and the stop already said about it. */
export type DoorSubject = Pick<ServicePublished, "service" | "door"> & {
  stop?: ChainStop | null;
};

export type DoorVerdict =
  /** No policy isolates these pods, or the path's stop has said it already. */
  | { state: "open" }
  | { state: "admitted" }
  | { state: "refused"; stop: PolicyStop }
  | { state: "unsure"; policies: string[]; why: DoorUnsure };

type Answer = boolean | DoorUnsure;

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

function peerAdmits(
  peer: PolicyPeer,
  client: DoorClient,
  home: string,
  namespaces: Known<LabeledNamespace[]>
): Answer {
  if (client.hostNetwork) return "hostNetwork";
  if (peer.ipBlock) {
    if (client.ip === null) return "clientsUnread";
    const inside = inCidr(client.ip, peer.ipBlock.cidr);
    const except = peer.ipBlock.except.map((cidr) =>
      inCidr(client.ip ?? "", cidr)
    );
    if (inside === null || except.includes(null)) return "unevaluable";
    // Whether an ipBlock applies to traffic from a pod is the network plugin's choice.
    return inside && !except.includes(true) ? "ipBlock" : false;
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

function ruleAdmits(
  rule: DoorRule,
  client: DoorClient,
  home: string,
  namespaces: Known<LabeledNamespace[]>
): Answer {
  if (rule.peers.length === 0) return true;
  let doubt: DoorUnsure | null = null;
  for (const peer of rule.peers) {
    const answer = peerAdmits(peer, client, home, namespaces);
    if (answer === true) return true;
    if (answer !== false) doubt ??= answer;
  }
  return doubt ?? false;
}

function clientAdmitted(
  port: DoorPort,
  unsettled: string[],
  client: DoorClient,
  home: string,
  namespaces: Known<LabeledNamespace[]>
): Answer {
  let doubt: DoorUnsure | null = null;
  for (const rule of port.rules) {
    const answer = ruleAdmits(rule, client, home, namespaces);
    if (answer === false) continue;
    const why =
      answer !== true
        ? answer
        : rule.byName
          ? "byName"
          : unsettled.includes(rule.policy)
            ? "unsettled"
            : null;
    if (why === null) return true;
    doubt ??= why;
  }
  return doubt ?? false;
}

/** Whether a controller may connect to the pods behind `published` on `backend`. */
export function doorVerdict(
  published: DoorSubject,
  backend: string | null,
  read: DoorRead | null | undefined
): DoorVerdict {
  if (published.stop?.reason === "policyRefuses") return { state: "open" };
  const door = published.door;
  if (!door || door.state === "unread")
    return { state: "unsure", policies: [], why: "policiesUnread" };
  if (door.state === "open" || door.isolating.length === 0)
    return { state: "open" };
  const policies = [...door.isolating, ...door.unsettled];
  const unsure = (why: DoorUnsure): DoorVerdict => ({
    state: "unsure",
    policies,
    why,
  });
  const port = doorPortOf(door.ports, backend);
  if (!port) return unsure("noPort");
  if (read === null) return unsure("noIntegration");
  if (read === undefined) return unsure("clientsReading");
  const { clients, namespaces } = read;
  if (!clients.known)
    return unsure(clients.why === null ? "clientsReading" : "clientsUnread");
  if (clients.value.length === 0) return unsure("noClients");
  const home = published.service.namespace ?? "";
  const answers = clients.value.map((client) =>
    clientAdmitted(port, door.unsettled, client, home, namespaces)
  );
  const doubt = answers.find(
    (answer): answer is DoorUnsure => typeof answer === "string"
  );
  if (doubt) return unsure(doubt);
  if (answers.every((answer) => answer === true)) return { state: "admitted" };
  if (answers.some((answer) => answer === true)) return unsure("someClients");
  return {
    state: "refused",
    stop: {
      reason: "policyRefuses",
      service: published.service,
      policies: door.isolating,
      ports: port.port === null ? [] : [port.port],
      noRules: false,
      client: {
        name: read.name,
        namespaces: [
          ...new Set(clients.value.map((client) => client.namespace)),
        ].sort(),
      },
    },
  };
}

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
  client: string;
  /** What the cluster answered where it refused to list the policies. */
  said: string | null;
}

/** Why `client` may or may not get through, where policies guard the pods and nothing settled it. */
export function doorDoubt(
  published: DoorSubject | undefined,
  backend: string | null,
  read: DoorRead | null | undefined,
  client: string
): DoorDoubt | null {
  if (!published || published.stop) return null;
  const verdict = doorVerdict(published, backend, read);
  const said =
    published.door?.state === "unread" ? published.door.reason : null;
  return verdict.state === "unsure" &&
    (verdict.policies.length > 0 || said !== null)
    ? {
        policies: verdict.policies,
        why: verdict.why,
        client: read?.name ?? client,
        said,
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
};

/** Why nobody settled it: the cluster's refusal where it gave one, else the reader's words. */
export const doorWhy = (doubt: DoorDoubt, t: T) =>
  doubt.said || t("nav", DOOR_WHY[doubt.why]);

/** A doubt in the words every reader draws it with; `behind` names the Service where nothing nearby does. */
export function doorDoubtWords(
  doubt: DoorDoubt,
  t: T,
  behind?: string
): { title: string; note: string } {
  const n = doubt.policies.length;
  const names = doubt.policies.join(", ");
  return {
    title:
      n === 0
        ? behind === undefined
          ? t("nav", "doorPoliciesUnread")
          : t("nav", "doorPoliciesUnreadFor", { service: behind })
        : behind === undefined
          ? t("count", "doorDecides", { n, names })
          : t("count", "doorDecidesFor", { n, names, service: behind }),
    note: t("nav", "doorUnsureNote", {
      client: doubt.client,
      why: doorWhy(doubt, t),
    }),
  };
}
