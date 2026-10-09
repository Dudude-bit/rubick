import { describe, expect, it } from "vite-plus/test";

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
    const stats = endpointsStats(endpoints, t, false);
    expect(stats).toMatchObject([
      { value: "1" },
      { value: "1", role: "warn" },
      { value: "1" },
    ]);
  });
});

describe("the addresses table", () => {
  it("carries a pod reference on the ready row and the word none on the unnamed one, deleting this breaks the row content", () => {
    const section = endpointsAddressesSection(endpoints, t, false);
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
            { text: "none" },
            { text: "none" },
          ],
        },
      ],
    });
  });
});

describe("with the Service's pods not read", () => {
  /**
   * Marco's ledger, pods unread: every reader of the Endpoints object drew
   * its not-ready address amber, Share included. Fails if the file draws a
   * fault's colour, or loses the not-read mark, where the screen does not.
   */
  it("draws a not-ready address with the not-read mark, not a fault's colour", () => {
    expect(endpointsStats(endpoints, t, true)[1]).toMatchObject({
      value: "1",
      role: "neutral",
      unread: true,
    });
    const { body } = endpointsAddressesSection(endpoints, t, true);
    if (body.type !== "table") throw new Error("expected the table");
    expect(body.rows.map((row) => row.cells[1])).toMatchObject([
      { role: "ok", unread: false },
      { role: "neutral", unread: true },
    ]);
  });
});
