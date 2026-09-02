import { describe, expect, it } from "vitest";

import { backingOf, type BackingSources } from "./ingress";
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
    ports: [],
    endpoints: [],
    whole: true,
    ...overrides,
  }) as unknown as ServicePublished;

const sources = (over: Partial<BackingSources> = {}): BackingSources => ({
  services: [service()],
  published: [published()],
  backingKnown: true,
  ...over,
});

const from = { kind: "HTTPRoute", name: "web", namespace: "shop" };

describe("what a route's backend is doing", () => {
  /**
   * This function holds the endpoints and no pod list, so it cannot tell a
   * selector matching nothing from pods that carry it and have no address
   * yet — Pending, unscheduled, still creating. The endpoint controller
   * writes nothing for those, so both look identical from here.
   *
   * It used to answer `selectsNothing`, which renders as "No pod carries
   * app=promo" and sends the reader to check their labels for a problem that
   * is in the scheduler. Rust, which does list the pods, says "N pods carry
   * this, none ready" about the very same Service.
   */
  it("does not claim a selector matches nothing when it never looked at pods", () => {
    const answer = backingOf(
      { name: "app", namespace: "shop" },
      from,
      sources()
    );

    expect(answer.stop?.reason).toBe("publishesNothingYet");
  });

  /** A draining address is still the one kube-proxy sends to, so a Service
   *  down to one is a restart rather than an outage — no stop at all. */
  it("calls a Service with a draining address still serving", () => {
    const answer = backingOf(
      { name: "app", namespace: "shop" },
      from,
      sources({ published: [published({ draining: 1 })] })
    );

    expect(answer.stop).toBeNull();
  });

  /** Endpoints written with no port resolved: the pods are Ready and every
   *  request gets a 502. That one this function can name. */
  it("still names the case where addresses exist and no port resolved", () => {
    const answer = backingOf(
      { name: "app", namespace: "shop" },
      from,
      sources({ published: [published({ unrouted: 2 })] })
    );

    expect(answer.stop?.reason).toBe("publishesNothing");
  });

  /** Nothing has been read yet: an empty list means "not yet" as readily as
   *  it means "none", and claiming a broken backend in that second is worse
   *  than saying nothing. */
  it("claims nothing at all before the lists have arrived", () => {
    const answer = backingOf(
      { name: "app", namespace: "shop" },
      from,
      sources({ backingKnown: false })
    );

    expect(answer.known).toBe(false);
  });
});
