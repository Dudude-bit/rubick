import { describe, expect, it } from "vite-plus/test";

import type {
  DoorRule,
  NetworkPolicyInfo,
  PolicyDoor,
  PolicyPeer,
  PolicyPort,
  PolicyRule,
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
  egress: { known: true, value: { rows: [], unread: [] } },
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
      side: "pods",
      said: null,
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
      side: "pods",
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
      side: "pods" as const,
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
      side: "pods",
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

describe("whether a controller's own egress policies let it reach a Service's pods", () => {
  const t: T = (section, key, values) => translate("en", section, key, values);
  const tcp = (
    port: string | null,
    endPort: number | null = null
  ): PolicyPort => ({
    protocol: "TCP",
    port,
    endPort,
  });
  const out = (
    peers: PolicyPeer[],
    ports: PolicyPort[] = [tcp("8080")]
  ): PolicyRule => ({ peers, ports });
  const holding = (
    rules: PolicyRule[],
    over: Partial<NetworkPolicyInfo> = {}
  ): NetworkPolicyInfo => ({
    name: "traefik-out",
    namespace: "traefik",
    uid: "traefik-out",
    selects: { kind: "everything" },
    selected: 1,
    ingress: {
      governed: false,
      rules: [],
      opensToEverything: false,
      deniesEverything: false,
    },
    egress: {
      governed: true,
      rules,
      opensToEverything: false,
      deniesEverything: rules.length === 0,
    },
    labels: {},
    createdAt: null,
    ...over,
  });
  const reached = (
    door: PolicyDoor | undefined = { state: "open" }
  ): ServicePublished => ({
    ...behind(door),
    ports: [{ name: "http", port: 8080, protocol: "TCP", exposed: true }],
    endpoints: [
      {
        address: "10.42.2.9",
        target: null,
        ready: true,
        serving: true,
        terminating: false,
        nodeName: null,
        zone: null,
        hintZones: [],
        ports: [8080],
      },
    ],
  });
  const leaving = (
    policies: NetworkPolicyInfo[],
    clients: DoorClient[] = [traefik]
  ): DoorRead => ({
    ...readOf(clients),
    egress: { known: true, value: { rows: policies, unread: [] } },
  });
  const judged = (
    rules: PolicyRule[],
    subject: ServicePublished = reached(),
    backend: string | null = "80"
  ) => doorVerdict(subject, backend, leaving([holding(rules)]));
  const block = (cidr: string): PolicyPeer => ({
    pods: { kind: "notSaid" },
    namespaces: { kind: "notSaid" },
    ipBlock: { cidr, except: [] },
  });

  /**
   * A default-deny egress over Traefik's pods let it reach DNS and nothing
   * else, and every Ingress through it read as served. Fails if the stop is
   * lost, names the wrong policy, or blames the pods' end.
   */
  it("holds back a controller whose own egress rules reach none of the pods, naming its policies", () => {
    expect(judged([out([fromNamespace("kube-system")], [tcp("53")])])).toEqual({
      state: "refused",
      stop: {
        reason: "policyHoldsBack",
        service: reached().service,
        client: { name: "Traefik", namespaces: ["traefik"] },
        policies: [
          {
            kind: "NetworkPolicy",
            name: "traefik-out",
            namespace: "traefik",
            existence: "present",
            facts: null,
          },
        ],
        ports: [8080],
      },
    });
    expect(judged([])).toMatchObject({
      state: "refused",
      stop: { reason: "policyHoldsBack" },
    });
  });

  it("lets a controller out where a rule names the pods' namespace on their port, or a range holding it", () => {
    expect(judged([out([fromNamespace("shop")])])).toEqual({
      state: "admitted",
    });
    expect(judged([out([fromNamespace("shop")], [tcp("8000", 8100)])])).toEqual(
      {
        state: "admitted",
      }
    );
    expect(judged([out([], [])])).toEqual({ state: "admitted" });
    expect(judged([out([fromNamespace("shop")], [tcp("9090")])])).toMatchObject(
      {
        state: "refused",
      }
    );
    expect(
      judged([
        out([fromNamespace("shop")], [{ ...tcp("8080"), protocol: "UDP" }]),
      ])
    ).toMatchObject({ state: "refused" });
  });

  /** Only a policy that selects the controller's pods says where they may go. */
  it("holds nothing back where no policy selects the controller's pods", () => {
    const elsewhere = holding([], {
      selects: { kind: "written", query: "app=other" },
    });
    expect(doorVerdict(reached(), "80", leaving([elsewhere]))).toEqual({
      state: "open",
    });
    expect(doorVerdict(reached(), "80", leaving([]))).toEqual({
      state: "open",
    });
  });

  /** Each egress rule this cannot settle keeps its own words, never a refusal or a pass. */
  it("cannot say where a rule picks pods by label, names its port by name, or names the pods' addresses by ipBlock", () => {
    const byLabel: PolicyPeer = {
      ...fromNamespace("shop"),
      pods: { kind: "written", query: "app=web" },
    };
    const cases: Array<[PolicyRule, string]> = [
      [out([byLabel]), "egressByPods"],
      [out([fromNamespace("shop")], [tcp("http")]), "byName"],
      [out([block("10.42.0.0/16")]), "egressIpBlock"],
    ];
    for (const [rule, why] of cases)
      expect(judged([rule])).toEqual({
        state: "unsure",
        policies: ["traefik-out"],
        why,
        side: "client",
        said: null,
      });
    expect(judged([out([block("192.168.0.0/16")])])).toMatchObject({
      state: "refused",
    });
    const unreadable = holding([], {
      selects: { kind: "written", query: "app in (" },
    });
    expect(doorVerdict(reached(), "80", leaving([unreadable]))).toMatchObject({
      state: "unsure",
      why: "unevaluable",
      policies: ["traefik-out"],
    });
    const unshipped = { ...reached(), endpoints: undefined };
    expect(
      doorVerdict(
        unshipped,
        "80",
        leaving([holding([out([block("192.168.0.0/16")])])])
      )
    ).toMatchObject({ state: "unsure", why: "egressIpBlock" });
  });

  it("cannot say for a controller on the node's network, nor for a port the backend does not pick", () => {
    const shut = [holding([])];
    expect(
      doorVerdict(
        reached(),
        "80",
        leaving(shut, [{ ...traefik, hostNetwork: true }])
      )
    ).toMatchObject({ state: "unsure", why: "hostNetwork", side: "client" });
    const two = {
      ...reached(),
      ports: [
        { name: "http", port: 8080, protocol: "TCP", exposed: true },
        { name: "admin", port: 9090, protocol: "TCP", exposed: true },
      ],
    };
    const http = [out([fromNamespace("shop")])];
    expect(judged(http, two, "80")).toMatchObject({
      state: "unsure",
      why: "noPort",
    });
    expect(judged(http, two, "http")).toEqual({ state: "admitted" });
    expect(judged(http, two, "admin")).toMatchObject({ state: "refused" });
  });

  /** A refusal at either end is the answer, and the pods' end is said first. */
  it("says a refusal at the pods' end first, and one at the controller's over a doubt at the pods'", () => {
    const shutOut = leaving([holding([])]);
    const refusing = reached(guarded([rule([fromNamespace("ingress-nginx")])]));
    expect(doorVerdict(refusing, "80", shutOut)).toMatchObject({
      stop: { reason: "policyRefuses" },
    });
    const doubted = reached(guarded([rule([block("10.42.0.0/16")])]));
    expect(doorVerdict(doubted, "80", shutOut)).toMatchObject({
      stop: { reason: "policyHoldsBack", ports: [8080] },
    });
    expect(doorVerdict(doubted, "80", leaving([]))).toMatchObject({
      state: "unsure",
      why: "ipBlock",
      side: "pods",
    });
  });

  /**
   * A refused list of the policies over Traefik's own pods is not an open
   * way out. Fails if the refusal is dropped, or said without the cluster's
   * words.
   */
  it("says the policies over the controller's own pods could not be read, in the cluster's words", () => {
    const message =
      'networkpolicies.networking.k8s.io is forbidden: User "dev" cannot list resource "networkpolicies" in the namespace "traefik"';
    const read: DoorRead = {
      ...readOf(),
      egress: {
        known: true,
        value: {
          rows: [],
          unread: [{ namespace: "traefik", code: "FORBIDDEN", message }],
        },
      },
    };
    const doubt = doorDoubt(reached(), "80", read, "traefik.io");
    expect(doubt).toEqual({
      policies: [],
      why: "egressUnread",
      side: "client",
      client: "Traefik",
      said: message,
    });
    if (!doubt) throw new Error("expected a doubt");
    expect(doorDoubtWords(doubt, t, "door-shut")).toEqual({
      title: "The NetworkPolicies over Traefik's own pods could not be read",
      note: `Whether Traefik may connect is not checked: ${message}.`,
    });
    const failed = {
      ...readOf(),
      egress: { known: false as const, why: "boom" },
    };
    expect(doorDoubt(reached(), "80", failed, "traefik.io")).toMatchObject({
      why: "egressUnread",
      said: "boom",
    });
  });

  /**
   * Before its pods and their policies are read there is nothing to name,
   * and a controller no integration speaks for is not judged at its own end.
   * Fails if every backend reads as unchecked while the reads are in flight.
   */
  it("draws no doubt while the controller's pods or their policies are being read", () => {
    const reading = {
      ...readOf(),
      egress: { known: false as const, why: null },
    };
    for (const read of [reading, readOf([]), undefined]) {
      expect(doorDoubt(reached(), "80", read, "traefik.io")).toBeNull();
      expect(refusedStop(reached(), "80", read)).toBeNull();
    }
    expect(doorVerdict(reached(), "80", null)).toEqual({ state: "open" });
  });

  it("names the policies over the controller's pods in a doubt's title", () => {
    const doubt = doorDoubt(
      reached(),
      "80",
      leaving([holding([out([block("10.42.0.0/16")])])]),
      "traefik.io"
    );
    if (!doubt) throw new Error("expected a doubt");
    expect(doorDoubtWords(doubt, t).title).toBe(
      "NetworkPolicy traefik-out over Traefik's pods decides whether it may reach these pods"
    );
    expect(doorDoubtWords(doubt, t, "door-block").title).toBe(
      "NetworkPolicy traefik-out over Traefik's pods decides whether it may reach the pods behind door-block"
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
