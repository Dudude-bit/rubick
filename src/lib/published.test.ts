import { describe, expect, it } from "vitest";

import {
  endpointState,
  legacyNote,
  publishedSummary,
  sourceNote,
  topologyNote,
  unpublishedNote,
} from "./published";
import type {
  PublishedEndpoint,
  ServicePublished,
  UnpublishedPod,
} from "@/generated/types";

const endpoint = (
  over: Partial<PublishedEndpoint> = {}
): PublishedEndpoint => ({
  address: "10.42.1.51",
  target: null,
  ready: true,
  serving: true,
  terminating: false,
  nodeName: "server-0",
  zone: null,
  hintZones: [],
  ports: [8080],
  ...over,
});

const published = (over: Partial<ServicePublished> = {}): ServicePublished => ({
  service: {
    kind: "Service",
    name: "shop-api",
    namespace: "k8s-gui-test",
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
  unpublished: [],
  ...over,
});

describe("the state of one address", () => {
  /** The distinction the legacy object cannot make, and the reason this
   *  feature exists: draining is not dead. */
  it("tells draining apart from not ready", () => {
    expect(
      endpointState(
        endpoint({ ready: false, serving: true, terminating: true })
      )
    ).toEqual({ text: "serving, terminating", tone: "warn" });
    expect(
      endpointState(
        endpoint({ ready: false, serving: false, terminating: false })
      )
    ).toEqual({ text: "not ready", tone: "err" });
    expect(endpointState(endpoint())).toEqual({ text: "ready", tone: "ok" });
  });
});

describe("where the answer came from", () => {
  /** A cluster below 1.21 serves no slices. Reporting a confident empty there
   *  would be the app inventing an outage out of its own API version. */
  it("says which object answered when it was not the slices", () => {
    expect(sourceNote(published())).toBeNull();
    expect(sourceNote(published({ source: "legacyEndpoints" }))).toContain(
      "served no EndpointSlices"
    );
    expect(sourceNote(published({ source: "podReadiness" }))).toContain(
      "a deduction rather than the cluster's own word"
    );
  });

  it("counts the slices it read", () => {
    expect(publishedSummary(published({ ready: 3, slices: 2 }))).toBe(
      "3 endpoints across 2 slices"
    );
  });
});

describe("the legacy object", () => {
  /**
   * Over capacity is impractical to stand up at 1000 endpoints, so the page's
   * sentence is asserted here. A page silently showing 1000 of 1240 is the
   * same class of lie as a sidecar count that skipped a container.
   */
  it("says how much of the answer it is holding when it was truncated", () => {
    const note = legacyNote(1000, true, published({ ready: 1240, slices: 12 }));
    expect(note).toContain("This object lists 1000 of 1240 addresses");
    expect(note).toContain("12 EndpointSlices");
    expect(note).toContain("endpoints.kubernetes.io/over-capacity");
  });

  /** Not every disagreement is truncation. A draining address is absent from
   *  this object entirely, because it has no word for it. */
  it("names the other reason it disagrees", () => {
    const note = legacyNote(0, false, published({ draining: 1 }));
    expect(note).toContain("This object lists 0 of 1 addresses");
    expect(note).toContain("draining is simply absent");
  });

  it("says they agree when they do", () => {
    expect(legacyNote(3, false, published({ ready: 3 }))).toContain(
      "3 addresses, and the slices agree"
    );
  });
});

describe("what is not published", () => {
  const pod = (name: string, ready: boolean): UnpublishedPod["pod"] => ({
    kind: "Pod",
    name,
    namespace: "k8s-gui-test",
    existence: "present",
    facts: { kind: "pod", phase: "Running", display: "Running", ready },
  });

  /** The finding worth the feature, on one pod rather than the whole
   *  Service: Ready, and reachable by nothing. */
  it("names the port when the app can derive it", () => {
    expect(
      unpublishedNote({
        pod: pod("shop-api-v3n9d", true),
        unnamedPorts: ["metrics"],
        inSlice: true,
      })
    ).toBe(
      "Ready, and in a slice that carries no port — targetPort: metrics matches no port this pod's containers declare"
    );
  });

  /** And stops where it cannot. Nothing else about why a pod is missing is
   *  written down in any object this call reads. */
  it("stops at what it holds when it cannot", () => {
    expect(
      unpublishedNote({
        pod: pod("shop-api-q4xkp", true),
        unnamedPorts: [],
        inSlice: false,
      })
    ).toBe("Ready, and in no slice at all");
  });
});

describe("topology", () => {
  /** Off on the overwhelming majority of Services, and a caption over a gap
   *  is worse than no caption. */
  it("says nothing when hints are off", () => {
    expect(topologyNote(published({ endpoints: [endpoint()] }))).toBeNull();
  });

  it("says what a client in each zone reaches", () => {
    const note = topologyNote(
      published({
        ready: 2,
        endpoints: [
          endpoint({ zone: "west1-b", hintZones: ["west1-b"] }),
          endpoint({ zone: "west1-c", hintZones: ["west1-c"] }),
        ],
      })
    );
    expect(note).toContain("a client in west1-b reaches 1 of 2");
    expect(note).toContain("a client in west1-c reaches 1 of 2");
  });
});
