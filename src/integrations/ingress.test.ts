import { describe, expect, it } from "vitest";

import { backingFrom, backingOf, type BackingSources } from "./ingress";
import type { ServiceInfo, ServicePublished } from "@/generated/types";

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
