import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a ServiceMonitor tells a reader with no cluster access", () => {
  it("names its selector and its endpoints", () => {
    const sections = reportOf(
      {
        group: "monitoring.coreos.com",
        kind: "ServiceMonitor",
        namespace: "shop",
        name: "api",
        spec: {
          selector: { matchLabels: { app: "api" } },
          endpoints: [{ port: "metrics", path: "/metrics", interval: "30s" }],
        },
        status: {},
      },
      t
    );
    expect(sections).toHaveLength(2);
    const [selectors, endpoints] = sections!;
    expect(selectors.body.type).toBe("facts");
    if (selectors.body.type !== "facts") throw new Error("expected facts");
    expect(selectors.body.rows[0]?.values[0]?.text).toBe("app=api");
    expect(endpoints.count).toBe(1);
    if (endpoints.body.type !== "table") throw new Error("expected a table");
    expect(endpoints.body.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      "metrics",
      "/metrics",
      "30s",
    ]);
  });
});

describe("what a PrometheusRule tells a reader with no cluster access", () => {
  it("lists every rule in every group", () => {
    const sections = reportOf(
      {
        group: "monitoring.coreos.com",
        kind: "PrometheusRule",
        namespace: "shop",
        name: "api-alerts",
        spec: {
          groups: [
            {
              name: "api.rules",
              rules: [{ alert: "ApiDown", expr: 'up{job="api"} == 0' }],
            },
          ],
        },
        status: {},
      },
      t
    );
    expect(sections?.[0]?.count).toBe(1);
    if (sections?.[0]?.body.type !== "table")
      throw new Error("expected a table");
    expect(sections[0].body.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      "api.rules",
      "ApiDown",
      'up{job="api"} == 0',
    ]);
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a VirtualService: that is Istio's kind, not the Prometheus Operator's", () => {
    const sections = reportOf(
      {
        group: "networking.istio.io",
        kind: "VirtualService",
        namespace: "shop",
        name: "web",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
