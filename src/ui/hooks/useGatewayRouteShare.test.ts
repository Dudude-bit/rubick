import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { RouteInfo } from "@/generated/types";
import {
  gatewayRouteConditionsSection,
  gatewayRouteRulesSection,
  gatewayRouteStats,
} from "./useGatewayRouteShare";

const t: T = (section, key, values) => translate("en", section, key, values);

const route: RouteInfo = {
  kind: "HTTPRoute",
  apiVersion: "gateway.networking.k8s.io/v1",
  name: "shop",
  namespace: "shop",
  hostnames: ["shop.example.com"],
  parentRefs: [
    {
      group: "",
      kind: "Gateway",
      name: "public",
      namespace: null,
      sectionName: null,
      port: null,
    },
  ],
  rules: [
    {
      matches: [
        {
          path: "/",
          pathType: "PathPrefix",
          method: null,
          grpcService: null,
          grpcMethod: null,
          headers: [],
          queryParams: [],
        },
      ],
      backendRefs: [
        {
          group: "",
          kind: "Service",
          name: "web",
          namespace: null,
          port: 80,
          weight: 1,
        },
      ],
      hasRedirect: false,
      extensionRefs: [],
    },
  ],
  parents: [
    {
      parent: {
        group: "",
        kind: "Gateway",
        name: "public",
        namespace: null,
        sectionName: null,
        port: null,
      },
      controllerName: "envoy",
      conditions: [
        {
          type: "Accepted",
          status: "False",
          reason: "NotAllowedByListeners",
          message: "no listener accepts this route",
          lastTransitionTime: null,
        },
      ],
    },
  ],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
};

describe("what a route report leads with", () => {
  it("carries the hostnames it serves", () => {
    const stats = gatewayRouteStats(route, t);
    expect(stats).toMatchObject([{ value: "shop.example.com" }]);
  });
});

describe("the route's per-parent status", () => {
  it("names which parent refused it, deleting this breaks the override", () => {
    const section = gatewayRouteConditionsSection(route, t);
    expect(section.body).toMatchObject({
      type: "findings",
      items: [
        {
          title: "Accepted",
          role: "err",
          ref: { kind: "Gateway" },
        },
      ],
    });
  });
});

describe("the rules table", () => {
  it("weights each backend with a reference, deleting this breaks the row content", () => {
    const section = gatewayRouteRulesSection(route, t);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "/…" },
            { text: "web", ref: { kind: "Service" } },
            { text: "80" },
            { text: "1" },
          ],
        },
      ],
    });
  });
});
