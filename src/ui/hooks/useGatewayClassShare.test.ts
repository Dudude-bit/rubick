import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { GatewayClassInfo } from "@/generated/types";
import { gatewayClassStats } from "./useGatewayClassShare";

const t: T = (section, key, values) => translate("en", section, key, values);

const cls = (over: Partial<GatewayClassInfo> = {}): GatewayClassInfo => ({
  name: "envoy",
  controllerName: "envoyproxy.io/gateway-controller",
  description: null,
  accepted: null,
  conditions: [],
  labels: {},
  annotations: {},
  createdAt: null,
  ...over,
});

describe("the claim a GatewayClass carries", () => {
  it("names the controller and says accepted, in the ok role", () => {
    const stats = gatewayClassStats(cls({ accepted: true }), t);
    expect(stats).toMatchObject([
      { value: "envoyproxy.io/gateway-controller" },
      { role: "ok" },
    ]);
  });

  it("says refused, in the err role, when the controller turned it down", () => {
    const stats = gatewayClassStats(cls({ accepted: false }), t);
    expect(stats[1]).toMatchObject({ role: "err" });
  });

  it("says nothing has answered, in the warn role, rather than defaulting to accepted", () => {
    const stats = gatewayClassStats(cls({ accepted: null }), t);
    expect(stats[1]).toMatchObject({ role: "warn" });
  });
});
