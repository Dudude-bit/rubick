import { describe, expect, it } from "vite-plus/test";

import {
  backendLinkTone,
  backendNode,
  backingFrom,
  backingOf,
  findingRole,
  findingTone,
  hostRole,
  stopCellLook,
  stopsRowState,
  stopsRowTone,
  stopWeight,
  type BackingSources,
} from "./ingress";
import type { StopMood } from "@/lib/connections";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  ChainStop,
  PolicyDoor,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";
import type { DoorRead } from "@/lib/policy-door";

const service = (overrides: Partial<ServiceInfo> = {}): ServiceInfo =>
  ({
    name: "app",
    namespace: "shop",
    type: "ClusterIP",
    clusterIp: "10.96.0.1",
    externalIps: [],
    loadBalancerIps: [],
    selector: { app: "promo" },
    ports: [],
    sessionAffinity: "None",
    labels: {},
    annotations: {},
    createdAt: null,
    ...overrides,
  }) as unknown as ServiceInfo;

const published = (
  overrides: Partial<ServicePublished> = {}
): ServicePublished =>
  ({
    service: {
      kind: "Service",
      name: "app",
      namespace: "shop",
      existence: "present",
      facts: null,
    },
    source: "slices",
    slices: 1,
    ready: 0,
    draining: 0,
    notReady: 0,
    unrouted: 0,
    unroutedReady: 0,
    ports: [],
    endpoints: [],
    whole: true,
    unpublished: [],
    stop: null,
    ...overrides,
  }) as unknown as ServicePublished;

const sources = (over: Partial<BackingSources> = {}): BackingSources => ({
  services: [service()],
  published: [published()],
  backingKnown: true,
  backingError: null,
  ...over,
});

const from = { kind: "HTTPRoute", name: "web", namespace: "shop" };

describe("what a route's backend is doing", () => {
  /**
   * Where the path stops is Rust's `service_stop`, the rule the connections
   * graph uses; this page only carries it. Deriving it again here from the
   * counts is how the two screens came to disagree about one Service.
   */
  it("carries the stop the backend decided, and none where it decided none", () => {
    const stop = {
      reason: "publishesNothingYet" as const,
      service: published().service,
      selector: "app=promo",
      podsUnread: false,
    };
    const backend = { name: "app", namespace: "shop" };

    expect(
      backingOf(backend, from, sources({ published: [published({ stop })] }))
        .stop
    ).toEqual(stop);
    expect(
      backingOf(
        backend,
        from,
        sources({ published: [published({ draining: 1 })] })
      ).stop
    ).toBeNull();
  });

  /**
   * The Traefik page drew a host over pods allow-nginx shuts to Traefik as
   * served. Fails if the page's controller stops being judged at the door of
   * the port the route names, or is judged on another port.
   */
  it("stops a route whose backend's policies refuse the page's controller", () => {
    const door: PolicyDoor = {
      state: "guarded",
      isolating: ["allow-nginx"],
      unsettled: [],
      ports: [
        {
          name: "http",
          servicePort: 80,
          port: 8080,
          protocol: "TCP",
          rules: [],
        },
      ],
    };
    const traefik: DoorRead = {
      name: "Traefik",
      clients: {
        known: true,
        value: [
          {
            name: "traefik-7d9",
            namespace: "traefik",
            labels: {},
            ip: "10.42.1.7",
            hostNetwork: false,
          },
        ],
      },
      namespaces: { known: true, value: [] },
    };
    const read = sources({
      published: [published({ ready: 2, door })],
      door: { client: "Traefik", read: traefik },
    });
    const backend = { name: "app", namespace: "shop" };
    expect(
      backingOf({ ...backend, port: "80" }, from, read).stop
    ).toMatchObject({
      reason: "policyRefuses",
      ports: [8080],
      client: { name: "Traefik", namespaces: ["traefik"] },
    });
    expect(backingOf({ ...backend, port: "9090" }, from, read).stop).toBeNull();
    expect(
      backingOf({ ...backend, port: "80" }, from, { ...read, door: undefined })
        .stop
    ).toBeNull();
  });

  /**
   * The Traefik page drew a host over pods only an ipBlock admits as served,
   * beside a chain that said nobody checked. Fails if the doubt is dropped,
   * or claimed on a page that judges no controller.
   */
  it("carries a doubt where the page's controller may or may not get through", () => {
    const door: PolicyDoor = {
      state: "guarded",
      isolating: ["allow-pod-cidr"],
      unsettled: [],
      ports: [
        {
          name: "http",
          servicePort: 80,
          port: 8080,
          protocol: "TCP",
          rules: [
            {
              policy: "allow-pod-cidr",
              byName: false,
              peers: [
                {
                  pods: { kind: "notSaid" },
                  namespaces: { kind: "notSaid" },
                  ipBlock: { cidr: "10.42.0.0/16", except: [] },
                },
              ],
            },
          ],
        },
      ],
    };
    const traefik: DoorRead = {
      name: "Traefik",
      clients: {
        known: true,
        value: [
          {
            name: "traefik-7d9",
            namespace: "traefik",
            labels: {},
            ip: "10.42.1.7",
            hostNetwork: false,
          },
        ],
      },
      namespaces: { known: true, value: [] },
    };
    const read = sources({
      published: [published({ ready: 1, door })],
      door: { client: "Traefik", read: traefik },
    });
    const backend = { name: "app", namespace: "shop", port: "80" };
    const doubted = backingOf(backend, from, read);
    expect(doubted.stop).toBeNull();
    expect(doubted.doubt).toEqual({
      policies: ["allow-pod-cidr"],
      why: "ipBlock",
      client: "Traefik",
    });
    expect(backingOf(backend, from, { ...read, door: undefined }).doubt).toBe(
      null
    );
  });

  /** A route naming a Service the list does not hold: the one stop only the
   *  route's own page can see, because only it knows who asked. */
  it("names a backend Service the cluster does not have", () => {
    const answer = backingOf(
      { name: "gone", namespace: "shop" },
      from,
      sources()
    );

    expect(answer.stop).toMatchObject({
      reason: "backendMissing",
      ingress: { kind: "HTTPRoute", name: "web" },
      service: { name: "gone", existence: "missing" },
    });
  });

  /** Nothing has been read yet: an empty list means "not yet" as readily as
   *  it means "none", and claiming a broken backend in that second is worse
   *  than saying nothing. */
  it("claims nothing at all before the lists have arrived", () => {
    const answer = backingOf(
      { name: "app", namespace: "shop" },
      from,
      sources({ backingKnown: false, backingError: null })
    );

    expect(answer.known).toBe(false);
  });

  /**
   * A refused read used to look exactly like one still in flight: the page
   * said "reading endpoints" for as long as it was open. The reason now
   * travels with the unknown.
   */
  it("says why it does not know when the lists were refused", () => {
    const refused = backingFrom(
      undefined,
      new Error("services is forbidden (code: 403)")
    );
    expect(refused.backingKnown).toBe(false);
    expect(refused.backingError).toContain("forbidden");

    const answer = backingOf({ name: "app", namespace: "shop" }, from, refused);
    expect(answer.known).toBe(false);
    expect(answer.error).toContain("forbidden");
  });

  /** Still reading is not a failure, and an answer is known whatever else failed. */
  it("keeps reading and read apart from refused", () => {
    expect(backingFrom(undefined, null)).toMatchObject({
      backingKnown: false,
      backingError: null,
    });
    expect(
      backingFrom({ services: [], published: [] }, new Error("a later refetch"))
    ).toMatchObject({ backingKnown: true, backingError: null });
  });
});

describe("how a host is coloured in a shared report", () => {
  const host = (over: Partial<Parameters<typeof hostRole>[0]> = {}) => ({
    worst: null,
    backendsKnown: true,
    tls: { at: "none" },
    ...over,
  });

  /** The Istio, ingress-nginx and Traefik lists dropped a host with unread
   *  backends from the report, and the page counted it as not checked. */
  it("reports a host nobody could check as neutral, not as clean", () => {
    expect(hostRole(host({ backendsKnown: false }))).toBe("neutral");
    expect(hostRole(host({ tls: { at: "unknown" } }))).toBe("neutral");
  });

  it("leaves out a host that was read and has nothing wrong", () => {
    expect(hostRole(host())).toBeNull();
  });

  it("keeps a host's own worst finding", () => {
    expect(hostRole(host({ worst: "err", backendsKnown: false }))).toBe("err");
  });
});

describe("how much a stopped backend weighs", () => {
  const behind = published().service;
  const stops = {
    fault: {
      reason: "selectsNothing",
      service: behind,
      selector: "app=promo",
      near: null,
      makersRead: true,
    },
    coming: {
      reason: "podsBeingMade",
      service: behind,
      selector: "app=promo",
      workloads: [],
    },
    idle: {
      reason: "scaledToZero",
      service: behind,
      selector: "app=promo",
      workloads: [],
    },
    unchecked: {
      reason: "publishesNothingYet",
      service: behind,
      selector: "app=promo",
      podsUnread: true,
    },
  } satisfies Record<StopMood, ChainStop>;

  /** Every routing page filed a Service scaled to zero, still starting or
   *  with its pods unread as an error, in red, beside a trace that drew the
   *  same stop grey or blue. */
  it("files only a fault as an error, and draws the rest in the trace's mood", () => {
    expect(stopWeight(stops.fault)).toEqual({
      severity: "err",
      tone: "err",
      row: "err",
    });
    expect(stopWeight(stops.coming)).toEqual({
      severity: "warn",
      tone: "warn",
      row: "warn",
    });
    expect(stopWeight(stops.idle)).toEqual({
      severity: "warn",
      tone: "mute",
      row: "warn",
    });
    expect(stopWeight(stops.unchecked)).toEqual({
      severity: "warn",
      tone: "unknown",
      row: "unknown",
    });
  });

  /** A finding nobody could check was drawn amber, beside a trace that drew it grey. */
  it("draws a host finding nobody could check unknown, never as a warning", () => {
    expect(findingTone({ kind: "door", severity: "warn" })).toBe("unknown");
    expect(findingRole({ kind: "door", severity: "warn" })).toBe("neutral");
    expect(
      findingTone({ kind: "stop", severity: "warn", stop: stops.unchecked })
    ).toBe("unknown");
    expect(
      findingTone({ kind: "stop", severity: "err", stop: stops.fault })
    ).toBe("err");
    expect(findingTone({ kind: "clear", severity: "warn" })).toBe("warn");
  });

  /** A backend behind a door nobody settled was a green node on the map. */
  it("draws a backend behind a doubted door unknown on the map", () => {
    const t: T = (section, key, values) =>
      translate("en", section, key, values);
    const backing = {
      ...backingOf(
        { name: "app", namespace: "shop" },
        from,
        sources({ published: [published({ ready: 1 })] })
      ),
      doubt: {
        policies: ["allow-pod-cidr"],
        why: "ipBlock" as const,
        client: "Traefik",
      },
    };
    const service = { name: "app", namespace: "shop", port: "80" };
    expect(backendNode("svc", service, backing, t)).toMatchObject({
      tone: "unknown",
      tag: { text: "1 ready", tone: "unknown" },
    });
    expect(backendLinkTone(backing, "ok")).toBe("unknown");
    const reached = { ...backing, doubt: null };
    expect(backendNode("svc", service, reached, t)).toMatchObject({
      tone: "ok",
      tag: { tone: "mute" },
    });
    expect(backendLinkTone(reached, "err")).toBe("warn");
  });

  /** A cell over a Service whose pods were not read was struck red as down. */
  it("draws a cell over an unread backend dashed and one scaled to zero plain", () => {
    expect(stopCellLook(stops.unchecked)).toEqual({
      bad: false,
      warn: false,
      unknown: true,
    });
    expect(stopCellLook(stops.idle)).toEqual({
      bad: false,
      warn: false,
      unknown: false,
    });
    expect(stopCellLook(stops.fault)).toEqual({
      bad: true,
      warn: false,
      unknown: false,
    });
  });

  /** Would break if the first stop on a host decided its tone rather than its worst. */
  it("colours a host line by its worst stop, and says nothing where none stopped", () => {
    expect(stopsRowTone([stops.unchecked, stops.idle, stops.fault])).toBe(
      "err"
    );
    expect(stopsRowTone([stops.unchecked, stops.coming])).toBe("warn");
    expect(stopsRowTone([stops.unchecked])).toBe("unknown");
    expect(stopsRowTone([])).toBeNull();
  });

  /** The host line over pods a policy shuts said "nothing behind it". */
  it("says a host line is shut where every worst stop is a policy", () => {
    const t: T = (section, key, values) =>
      translate("en", section, key, values);
    const shut = {
      reason: "policyRefuses",
      service: behind,
      policies: ["deny-all"],
      ports: [],
      noRules: true,
      client: null,
    } satisfies ChainStop;
    expect(stopsRowState([shut, stops.idle], t)).toEqual({
      text: "shut by NetworkPolicy",
      tone: "err",
    });
    expect(stopsRowState([shut, stops.fault], t)?.text).toBe(
      "nothing behind it"
    );
    expect(stopsRowState([stops.idle], t)?.text).toBe("nothing behind it");
    expect(stopsRowState([], t)).toBeNull();
  });
});
