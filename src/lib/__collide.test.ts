import { describe, expect, it } from "vitest";
import { routeTraces } from "@/lib/route-trace";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { GatewayInfo, RouteInfo } from "@/generated/types";

const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

const gw: GatewayInfo = {
  name: "gwtest",
  namespace: "edge",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "envoy",
  listenerSets: [
    { name: "app-tls", namespace: "edge" },
    { name: "app-mtls", namespace: "edge" },
  ],
  listeners: [],
  addresses: ["203.0.113.10"],
  conditions: [
    { type: "Programmed", status: "True", reason: "Programmed",
      message: null, lastTransitionTime: null, observedGeneration: 1 },
  ],
  generation: 1, labels: {}, annotations: {}, createdAt: null,
};

const set = (name: string) => ({
  group: "gateway.networking.k8s.io",
  kind: "ListenerSet",
  name, namespace: null, sectionName: null, port: null,
});

const shop = {
  kind: "HTTPRoute",
  apiVersion: "gateway.networking.k8s.io/v1",
  name: "shop", namespace: "edge",
  hostnames: ["shop.example.com"],
  parentRefs: [set("app-tls"), set("app-mtls")],
  rules: [], parents: [],
  generation: 1, labels: {}, annotations: {}, createdAt: null,
} as unknown as RouteInfo;

describe("two ListenerSets, one Gateway", () => {
  it("shows what the React key and the via label become", () => {
    const traces = routeTraces(shop, {
      gateways: [gw],
      classes: [{ name: "envoy", controllerName: "example.net/gw",
        description: null, accepted: true, conditions: [],
        labels: {}, annotations: {}, createdAt: null }],
      topologyKnown: true,
      backing: { services: [], published: [], backingKnown: true },
    }, t);

    const keys = traces.map(
      (x) => `${x.gateway.namespace}/${x.gateway.name}/${x.gateway.sectionName ?? ""}`
    );
    console.log("TRACES:", traces.length);
    console.log("KEYS:", JSON.stringify(keys));
    console.log("GATEWAY IDENTITIES:", JSON.stringify(traces.map((x) => x.gateway)));
    expect(traces).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});
