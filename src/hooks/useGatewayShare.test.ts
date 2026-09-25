import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { GatewayInfo } from "@/generated/types";
import {
  gatewayListenerConditionsSection,
  gatewayListenersSection,
  gatewayStats,
} from "./useGatewayShare";

const t: T = (section, key, values) => translate("en", section, key, values);

const gateway = (over: Partial<GatewayInfo> = {}): GatewayInfo => ({
  name: "public",
  namespace: "gw",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "envoy",
  listeners: [
    {
      name: "https",
      port: 443,
      protocol: "HTTPS",
      hostname: "shop.example.com",
      tlsMode: "Terminate",
      certificateRefs: [],
      allowedNamespaces: null,
      attachedRoutes: 3,
      conditions: [
        {
          type: "Programmed",
          status: "False",
          reason: "Invalid",
          message: "bad cert",
          lastTransitionTime: null,
        },
      ],
      fromListenerSet: null,
    },
  ],
  listenerSets: [],
  listenerSetsKnown: true,
  addresses: ["203.0.113.9"],
  conditions: [
    {
      type: "Programmed",
      status: "True",
      reason: "Programmed",
      message: null,
      lastTransitionTime: null,
    },
  ],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
  ...over,
});

describe("what the Gateway report leads with", () => {
  it("names the class, whether a controller programmed it, and its addresses", () => {
    const stats = gatewayStats(gateway(), t);
    expect(stats).toMatchObject([
      { value: "envoy" },
      { role: "ok" },
      { value: "203.0.113.9" },
    ]);
  });

  it("warns when nothing has programmed the Gateway yet", () => {
    const stats = gatewayStats(gateway({ conditions: [] }), t);
    expect(stats[1]).toMatchObject({ role: "warn" });
  });
});

describe("the listeners table", () => {
  it("carries a broken listener's reason in the status cell, deleting this breaks the row content", () => {
    const section = gatewayListenersSection(gateway(), t);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "https" },
            { text: "443" },
            { text: "HTTPS" },
            { text: "shop.example.com" },
            { text: "3" },
            { text: "Invalid", role: "err" },
          ],
        },
      ],
    });
  });
});

describe("listener conditions", () => {
  it("names which listener each condition belongs to", () => {
    const section = gatewayListenerConditionsSection(gateway(), t);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "https" },
            { text: "Programmed" },
            { text: "False", role: "err" },
            { text: "Invalid" },
          ],
        },
      ],
    });
  });
});
