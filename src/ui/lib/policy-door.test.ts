import { describe, expect, it } from "vite-plus/test";

import type {
  DoorRule,
  PolicyDoor,
  PolicyPeer,
  ServicePublished,
} from "@/generated/types";
import type { Known } from "@/lib/known";
import type { LabeledNamespace } from "@/lib/policy-peers";
import {
  doorDoubt,
  doorDoubtWords,
  doorPortOf,
  doorVerdict,
  refusedStop,
  type DoorClient,
  type DoorRead,
} from "./policy-door";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

const namespaces: Known<LabeledNamespace[]> = {
  known: true,
  value: ["traefik", "ingress-nginx", "shop"].map((name) => ({
    name,
    labels: { "kubernetes.io/metadata.name": name },
  })),
};

const traefik: DoorClient = {
  name: "traefik-7d9",
  namespace: "traefik",
  labels: { "app.kubernetes.io/name": "traefik" },
  ip: "10.42.1.7",
  hostNetwork: false,
};

const fromNamespace = (name: string): PolicyPeer => ({
  pods: { kind: "notSaid" },
  namespaces: { kind: "written", query: `kubernetes.io/metadata.name=${name}` },
  ipBlock: null,
});

const rule = (peers: PolicyPeer[], over: Partial<DoorRule> = {}): DoorRule => ({
  policy: "allow-nginx",
  peers,
  byName: false,
  ...over,
});

const guarded = (
  rules: DoorRule[],
  over: Partial<Extract<PolicyDoor, { state: "guarded" }>> = {}
): PolicyDoor => ({
  state: "guarded",
  isolating: ["allow-nginx"],
  unsettled: [],
  ports: [
    { name: "http", servicePort: 80, port: 8080, protocol: "TCP", rules },
  ],
  ...over,
});

const behind = (door: PolicyDoor | undefined): ServicePublished => ({
  service: {
    kind: "Service",
    name: "web",
    namespace: "shop",
    existence: "present",
    facts: null,
  },
  source: "slices",
  slices: 1,
  ready: 2,
  draining: 0,
  notReady: 0,
  unrouted: 0,
  unroutedReady: 0,
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
  stop: null,
  door,
});

const readOf = (
  clients: DoorClient[] = [traefik],
  read: Known<LabeledNamespace[]> = namespaces
): DoorRead => ({
  name: "Traefik",
  clients: { known: true, value: clients },
  namespaces: read,
});

const verdict = (
  door: PolicyDoor | undefined,
  clients: DoorClient[] = [traefik],
  read: Known<LabeledNamespace[]> = namespaces,
  backend: string | null = "80"
) => doorVerdict(behind(door), backend, readOf(clients, read));

describe("whether a controller gets through the policies over a Service's pods", () => {
  /** The specimen: only ingress-nginx is admitted while Traefik serves the route. */
  it("refuses a controller no rule's peer names, naming the policy", () => {
    expect(verdict(guarded([rule([fromNamespace("ingress-nginx")])]))).toEqual({
      state: "refused",
      stop: {
        reason: "policyRefuses",
        service: behind(undefined).service,
        policies: ["allow-nginx"],
        ports: [8080],
        noRules: false,
        client: { name: "Traefik", namespaces: ["traefik"] },
      },
    });
  });

  it("admits a controller a rule's peer names", () => {
    expect(verdict(guarded([rule([fromNamespace("traefik")])]))).toEqual({
      state: "admitted",
    });
  });

  /** A namespaceSelector over unread namespaces must not read as a refusal. */
  it("cannot say where the namespaces a peer names were not read", () => {
    const door = guarded([rule([fromNamespace("ingress-nginx")])]);
    expect(
      verdict(door, [traefik], { known: false, why: "forbidden" })
    ).toMatchObject({
      state: "unsure",
      why: "namespacesUnread",
    });
  });

  /** A policy sees a host-network pod as its node, which the network plugin decides about. */
  it("cannot say for a controller on the node's network, ipBlock or not", () => {
    const onNode = [{ ...traefik, hostNetwork: true }];
    const outside: PolicyPeer = {
      pods: { kind: "notSaid" },
      namespaces: { kind: "notSaid" },
      ipBlock: { cidr: "192.168.0.0/16", except: [] },
    };
    for (const peer of [fromNamespace("ingress-nginx"), outside]) {
      expect(verdict(guarded([rule([peer])]), onNode)).toMatchObject({
        state: "unsure",
        why: "hostNetwork",
      });
    }
  });

  /** A rule naming the port by a container port's name may not take this port at all. */
  it("cannot say where the admitting rule names its port by name", () => {
    const door = guarded([rule([fromNamespace("traefik")], { byName: true })]);
    expect(verdict(door)).toMatchObject({ state: "unsure", why: "byName" });
  });

  /** An allow from a policy that may not select these pods does not apply for certain. */
  it("cannot say where the admitting rule's policy may not select these pods", () => {
    const door = guarded(
      [rule([fromNamespace("traefik")], { policy: "edge" })],
      {
        unsettled: ["edge"],
      }
    );
    expect(verdict(door)).toMatchObject({
      state: "unsure",
      why: "unsettled",
      policies: ["allow-nginx", "edge"],
    });
  });

  it("cannot say when some of the controller's pods are admitted and some are not", () => {
    const door = guarded([rule([fromNamespace("traefik")])]);
    const elsewhere = { ...traefik, name: "traefik-b", namespace: "shop" };
    expect(verdict(door, [traefik, elsewhere])).toMatchObject({
      state: "unsure",
      why: "someClients",
    });
  });

  /** An ipBlock is applied to pod traffic or not by the network plugin; outside it, nothing is admitted. */
  it("cannot say for an address inside an ipBlock, and refuses one outside it", () => {
    const block = (cidr: string): PolicyPeer => ({
      pods: { kind: "notSaid" },
      namespaces: { kind: "notSaid" },
      ipBlock: { cidr, except: [] },
    });
    expect(verdict(guarded([rule([block("10.42.0.0/16")])]))).toMatchObject({
      state: "unsure",
      why: "ipBlock",
    });
    expect(verdict(guarded([rule([block("192.168.0.0/16")])]))).toMatchObject({
      state: "refused",
    });
  });

  /** Unread policies are not an open door, and a stop already said is not said twice. */
  it("says the policies were not read, and leaves a source-free refusal to its stop", () => {
    expect(verdict(undefined)).toEqual({
      state: "unsure",
      policies: [],
      why: "policiesUnread",
    });
    expect(verdict({ state: "open" })).toEqual({ state: "open" });
    const stopped = behind(guarded([]));
    stopped.stop = {
      reason: "policyRefuses",
      service: stopped.service,
      policies: ["allow-nginx"],
      ports: [8080],
      noRules: false,
      client: null,
    };
    expect(doorVerdict(stopped, "80", readOf())).toEqual({ state: "open" });
    expect(refusedStop(stopped, "80", readOf())).toBeNull();
  });

  /** Each way of not knowing the controller's pods keeps its own words, never a refusal. */
  it("cannot say for an unpublished port, nor for a controller whose pods are not known", () => {
    const door = guarded([rule([fromNamespace("ingress-nginx")])]);
    expect(verdict(door, [traefik], namespaces, "9999")).toMatchObject({
      state: "unsure",
      why: "noPort",
    });
    const asked = (read: DoorRead | null | undefined) =>
      doorVerdict(behind(door), "80", read);
    const unread = (why: string | null): DoorRead => ({
      ...readOf(),
      clients: { known: false, why },
    });
    expect(asked(null)).toMatchObject({ why: "noIntegration" });
    expect(asked(undefined)).toMatchObject({ why: "clientsReading" });
    expect(asked(unread(null))).toMatchObject({ why: "clientsReading" });
    expect(asked(unread("forbidden"))).toMatchObject({ why: "clientsUnread" });
    expect(asked(readOf([]))).toMatchObject({ why: "noClients" });
    expect(refusedStop(behind(door), "80", null)).toBeNull();
  });

  /** The stop a refusal makes is what every surface reading a path's stop draws. */
  it("makes a refusal of one controller the path's stop, and nothing else one", () => {
    const shut = behind(guarded([rule([fromNamespace("ingress-nginx")])]));
    expect(refusedStop(shut, "80", readOf())?.client?.name).toBe("Traefik");
    const open = behind(guarded([rule([fromNamespace("traefik")])]));
    expect(refusedStop(open, "80", readOf())).toBeNull();
    expect(refusedStop(undefined, "80", readOf())).toBeNull();
  });
});

describe("a controller's way in nobody could settle", () => {
  const t: T = (section, key, values) => translate("en", section, key, values);
  const block: PolicyPeer = {
    pods: { kind: "notSaid" },
    namespaces: { kind: "notSaid" },
    ipBlock: { cidr: "10.42.0.0/16", except: [] },
  };

  /**
   * Every reader beside the chain drew a door only the network plugin can
   * answer for as an open one. Fails if a doubt is lost, or if an open,
   * refused or unread door is called one.
   */
  it("holds a doubt only where policies guard the pods and the answer is not known", () => {
    const doubted = behind(guarded([rule([block])]));
    expect(doorDoubt(doubted, "80", readOf(), "traefik.io")).toEqual({
      policies: ["allow-nginx"],
      why: "ipBlock",
      client: "Traefik",
      said: null,
    });
    expect(doorDoubt(doubted, "80", undefined, "traefik.io")).toMatchObject({
      why: "clientsReading",
      client: "traefik.io",
    });
    const open = behind(guarded([rule([fromNamespace("traefik")])]));
    const shut = behind(guarded([rule([fromNamespace("ingress-nginx")])]));
    for (const subject of [open, shut, behind(undefined), undefined])
      expect(doorDoubt(subject, "80", readOf(), "traefik.io")).toBeNull();
  });

  /** A finding away from the chain has no pods above it for "these" to point at. */
  it("names the Service its pods are behind where nothing nearby does", () => {
    const doubt = {
      policies: ["allow-pod-cidr"],
      why: "ipBlock" as const,
      client: "Traefik",
      said: null,
    };
    expect(doorDoubtWords(doubt, t).title).toBe(
      "NetworkPolicy allow-pod-cidr decides who may connect to these pods"
    );
    expect(doorDoubtWords(doubt, t, "door-block")).toEqual({
      title:
        "NetworkPolicy allow-pod-cidr decides who may connect to the pods behind door-block",
      note: expect.stringMatching(
        /^Whether Traefik may connect is not checked: an ipBlock holds/
      ),
    });
  });

  /**
   * A refused NetworkPolicy list left the door unsaid, and a host over
   * policies nobody read was called served. Fails if the refusal is lost,
   * read as an open door, or said without the cluster's words.
   */
  it("says the door of pods whose policies could not be listed, in the cluster's words", () => {
    const reason =
      'networkpolicies.networking.k8s.io is forbidden: User "dev" cannot list resource "networkpolicies"';
    const doubt = doorDoubt(
      behind({ state: "unread", reason }),
      "80",
      readOf(),
      "traefik.io"
    );
    expect(doubt).toEqual({
      policies: [],
      why: "policiesUnread",
      client: "Traefik",
      said: reason,
    });
    if (!doubt) throw new Error("expected a doubt");
    expect(doorDoubtWords(doubt, t, "door-block")).toEqual({
      title:
        "The NetworkPolicies over the pods behind door-block could not be read",
      note: `Whether Traefik may connect is not checked: ${reason}.`,
    });
    expect(doorDoubtWords(doubt, t).title).toBe(
      "The NetworkPolicies over these pods could not be read"
    );
  });
});

describe("which door port an Ingress backend sends to", () => {
  const ports = [
    { name: "http", servicePort: 80, port: 8080, protocol: "TCP", rules: [] },
    {
      name: "metrics",
      servicePort: 9090,
      port: 9090,
      protocol: "TCP",
      rules: [],
    },
  ];

  /** An Ingress names the Service's port, never the pod's: 80, not 8080. */
  it("finds a port by the Service's number or name, and no other", () => {
    expect(doorPortOf(ports, "80")?.name).toBe("http");
    expect(doorPortOf(ports, "metrics")?.port).toBe(9090);
    expect(doorPortOf(ports, "8080")).toBeNull();
    expect(doorPortOf(ports, null)).toBeNull();
    expect(doorPortOf(ports.slice(0, 1), null)?.name).toBe("http");
  });
});
