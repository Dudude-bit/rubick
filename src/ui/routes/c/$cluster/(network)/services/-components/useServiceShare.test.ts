import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  ResourceConnections,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import {
  serviceStats,
  servicePortsSection,
  serviceSelectorSection,
  servicePublishedSection,
} from "./useServiceShare";

const t: T = (section, key, values) => translate("en", section, key, values);

const service: ServiceInfo = {
  name: "checkout",
  namespace: "shop",
  uid: "u1",
  type: "ClusterIP",
  sessionAffinity: "None",
  clusterIp: "10.0.0.5",
  externalName: null,
  externalIps: [],
  loadBalancerIps: [],
  ports: [
    {
      name: "http",
      port: 80,
      targetPort: "8080",
      nodePort: null,
      protocol: "TCP",
    },
  ],
  selector: { app: "checkout" },
  labels: {},
  annotations: {},
  createdAt: null,
};

const published = (over: Partial<ServicePublished> = {}): ServicePublished => ({
  service: {
    kind: "Service",
    name: "checkout",
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
  ...over,
});

const connectionsOf = (
  data: ResourceConnections | undefined
): ConnectionsQuery =>
  ({ data, error: null, isPending: data === undefined }) as ConnectionsQuery;

describe("what the Service report leads with", () => {
  it("carries type, cluster IP and port count with no endpoints read yet", () => {
    const stats = serviceStats(service, undefined, t);
    expect(stats.map((s) => s.value)).toEqual(["ClusterIP", "10.0.0.5", "1"]);
  });

  it("adds a ready/total stat once endpoints are known, coloured warn when short", () => {
    const stats = serviceStats(
      service,
      published({ ready: 1, notReady: 1 }),
      t
    );
    const last = stats.at(-1);
    expect(last).toMatchObject({ value: "1/2", role: "warn" });
  });

  /**
   * Zero ready of zero is not "all ready": the Published tab says the
   * Service publishes nothing and the chain ends in a red stop, and the
   * file led with `0/0` and a green check above it.
   */
  it("does not call a Service that publishes nothing healthy", () => {
    const last = serviceStats(
      service,
      published({ ready: 0, draining: 0, notReady: 0 }),
      t
    ).at(-1);
    expect(last).toMatchObject({ value: "0/0", role: "warn" });
    expect(last?.note).toBeTruthy();
  });

  /**
   * hello-web at zero: the page says no pods by intent, and the file must
   * not lead with the amber "publishes nothing". Fails if the idle stop is
   * read as an empty Service.
   */
  it("says a Service whose workloads are scaled to zero has no pods by intent, without colour", () => {
    const last = serviceStats(
      service,
      published({
        ready: 0,
        slices: 0,
        stop: {
          reason: "scaledToZero",
          service: published().service,
          selector: "app=checkout",
          workloads: [{ ...published().service, kind: "Deployment" }],
        },
      }),
      t
    ).at(-1);
    expect(last).toMatchObject({
      value: "0/0",
      role: "neutral",
      note: "No pods by intent: checkout is scaled to zero",
    });
  });

  /**
   * Sam's big-pull, shared while its pod pulled an image: the page said
   * coming up and the file would lead with an amber "publishes nothing".
   * Fails if a Service waiting on its workload's pods is drawn as an empty
   * one, or one whose pods were not read loses the not-read mark.
   */
  it("says a Service with nothing yet behind a workload coming up is coming up", () => {
    const stat = (stop: ServicePublished["stop"]) =>
      serviceStats(service, published({ ready: 0, stop }), t).at(-1);
    expect(
      stat({
        reason: "noneReady",
        service: published().service,
        selector: "app=checkout",
        pods: 1,
        why: "comingUp",
      })
    ).toMatchObject({
      value: "0/0",
      role: "pending",
      note: "1 pod carries app=checkout, and it is not ready: still starting",
    });
    expect(
      stat({
        reason: "publishesNothingYet",
        service: published().service,
        selector: "app=checkout",
        podsUnread: true,
      })
    ).toMatchObject({ value: "0/0", role: "neutral", unread: true });
  });

  /**
   * With neither EndpointSlices nor Endpoints readable, the count is
   * deduced from pods; it is not the controller's word, and says so.
   */
  it("draws a count deduced from pods without colour, with the page's note", () => {
    const last = serviceStats(
      service,
      published({ source: "podReadiness", ready: 2 }),
      t
    ).at(-1);
    expect(last).toMatchObject({ value: "2/2", role: "neutral" });
    expect(last?.note).toBeTruthy();
  });
});

describe("the ports the Service declares", () => {
  it("lists every port as a table row, deleting this breaks the row content", () => {
    const section = servicePortsSection(service, t);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "http" },
            { text: "80" },
            { text: "8080" },
            { text: "TCP" },
            { text: "none" },
          ],
        },
      ],
    });
  });
});

describe("the pod selector", () => {
  it("turns each label into a fact row", () => {
    const section = serviceSelectorSection(service, t);
    expect(section.body).toMatchObject({
      type: "facts",
      rows: [{ label: "app", values: [{ text: "checkout" }] }],
    });
  });
});

describe("what the Service actually publishes", () => {
  it("says the read is still in flight rather than claiming there are no endpoints", () => {
    const section = servicePublishedSection(connectionsOf(undefined), t);
    expect(section.unread).toBeTruthy();
  });

  it("lists ready and not-ready addresses with a pod reference once known", () => {
    const connections = connectionsOf({
      subject: {
        kind: "Service",
        name: "checkout",
        namespace: "shop",
        existence: "present",
        facts: null,
      },
      edges: [],
      stops: [],
      notLookedAt: [],
      published: [
        published({
          endpoints: [
            {
              address: "10.42.0.1",
              target: {
                kind: "Pod",
                name: "checkout-abc",
                namespace: "shop",
                existence: "present",
                facts: null,
              },
              ready: true,
              serving: true,
              terminating: false,
              nodeName: null,
              zone: null,
              hintZones: [],
              ports: [8080],
            },
          ],
        }),
      ],
    });
    const section = servicePublishedSection(connections, t);
    expect(section.unread).toBeNull();
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "10.42.0.1:8080" },
            { text: "checkout-abc" },
            { role: "ok" },
          ],
        },
      ],
    });
  });
});

describe("the shared file's Cluster IP", () => {
  /** It printed "None" for an ExternalName Service, the headless literal for an address it does not have. */
  it("says none for an alias and labels the headless literal", () => {
    const of = (clusterIp: string | null, type: string) =>
      serviceStats({ ...service, type, clusterIp }, undefined, t)[1].value;
    expect(of(null, "ExternalName")).toBe("none");
    expect(of("None", "ClusterIP")).toBe("None (headless)");
    expect(of("10.0.0.5", "ClusterIP")).toBe("10.0.0.5");
  });
});
