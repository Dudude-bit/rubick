import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { EndpointsInfo } from "@/generated/types";
import { endpointsAddressesSection, endpointsStats } from "./useEndpointsShare";

const t: T = (section, key, values) => translate("en", section, key, values);

const endpoints: EndpointsInfo = {
  name: "checkout",
  namespace: "shop",
  createdAt: null,
  overCapacity: false,
  subsets: [
    {
      addresses: [
        {
          ip: "10.42.0.1",
          hostname: null,
          nodeName: "node-a",
          targetRef: { kind: "Pod", name: "checkout-abc", namespace: "shop" },
        },
      ],
      notReadyAddresses: [
        {
          ip: "10.42.0.2",
          hostname: null,
          nodeName: null,
          targetRef: null,
        },
      ],
      ports: [{ name: "http", port: 80, protocol: "TCP" }],
    },
  ],
};

describe("what the Endpoints page leads with", () => {
  it("counts ready and not-ready addresses separately, colouring a gap warn", () => {
    const stats = endpointsStats(endpoints, t);
    expect(stats).toMatchObject([
      { value: "1" },
      { value: "1", role: "warn" },
      { value: "1" },
    ]);
  });
});

describe("the addresses table", () => {
  it("carries a pod reference on the ready row and a plain dash on the unnamed one, deleting this breaks the row content", () => {
    const section = endpointsAddressesSection(endpoints, t);
    expect(section.count).toBe(2);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "10.42.0.1" },
            { role: "ok" },
            { text: "checkout-abc" },
            { text: "node-a" },
          ],
        },
        {
          cells: [
            { text: "10.42.0.2" },
            { role: "err" },
            { text: "–" },
            { text: "–" },
          ],
        },
      ],
    });
  });
});
