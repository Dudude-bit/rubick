import { describe, expect, it } from "vitest";

import type {
  CustomResourceInfo,
  NamespaceInfo,
  ServiceInfo,
} from "@/generated/types";
import type { Read } from "./data";
import {
  monitorReaches,
  pickedUpBy,
  poolPrefix,
  readMonitor,
  readPrometheus,
  rowsOf,
  scrapeOf,
  selectedServices,
  selectorMatches,
  type Monitor,
  type TargetsRead,
} from "./model";

const cr = (
  kind: string,
  name: string,
  namespace: string,
  spec: unknown,
  labels: Record<string, string> = {},
  status: unknown = null
): CustomResourceInfo => ({
  name,
  namespace,
  uid: `${namespace}/${kind}/${name}`,
  apiVersion: "monitoring.coreos.com/v1",
  kind,
  spec,
  status,
  labels,
  annotations: {},
  createdAt: null,
  ownerReferences: [],
  generation: 1,
});

const service = (
  name: string,
  namespace: string,
  labels: Record<string, string>
): ServiceInfo =>
  ({ name, namespace, uid: `${namespace}/${name}`, labels }) as ServiceInfo;

const ok = <T>(items: T[]): Read<T> => ({ ok: true, items });
const refused = <T>(): Read<T> => ({ ok: false, reason: "forbidden" });

const monitor = (
  name: string,
  namespace: string,
  spec: unknown,
  labels: Record<string, string> = { release: "kps" }
): Monitor =>
  readMonitor(
    cr("ServiceMonitor", name, namespace, spec, labels),
    "ServiceMonitor"
  );

describe("selectorMatches", () => {
  /** The operator's own asymmetry: a missing selector selects nothing, an empty one everything. */
  it("treats a missing selector as nothing and an empty one as everything", () => {
    expect(selectorMatches(null, { a: "b" })).toBe(false);
    expect(selectorMatches(undefined, { a: "b" })).toBe(false);
    expect(selectorMatches({}, { a: "b" })).toBe(true);
    expect(selectorMatches({}, {})).toBe(true);
  });

  it("matches labels and the four expression operators", () => {
    expect(
      selectorMatches({ matchLabels: { app: "web" } }, { app: "web" })
    ).toBe(true);
    expect(
      selectorMatches({ matchLabels: { app: "web" } }, { app: "db" })
    ).toBe(false);
    const labels = { tier: "front", env: "prod" };
    expect(
      selectorMatches(
        {
          matchExpressions: [
            { key: "tier", operator: "In", values: ["front", "edge"] },
          ],
        },
        labels
      )
    ).toBe(true);
    expect(
      selectorMatches(
        {
          matchExpressions: [
            { key: "tier", operator: "NotIn", values: ["front"] },
          ],
        },
        labels
      )
    ).toBe(false);
    expect(
      selectorMatches(
        { matchExpressions: [{ key: "env", operator: "Exists" }] },
        labels
      )
    ).toBe(true);
    expect(
      selectorMatches(
        { matchExpressions: [{ key: "zone", operator: "DoesNotExist" }] },
        labels
      )
    ).toBe(true);
    expect(
      selectorMatches(
        { matchExpressions: [{ key: "zone", operator: "Weird" }] },
        labels
      )
    ).toBe(false);
  });
});

describe("monitorReaches", () => {
  /** An absent or empty namespaceSelector is the monitor's own namespace, which is not "all". */
  it("reaches its own namespace unless told otherwise", () => {
    expect(monitorReaches("shop", null, "shop")).toBe(true);
    expect(monitorReaches("shop", null, "pay")).toBe(false);
    expect(monitorReaches("shop", { any: false, matchNames: [] }, "pay")).toBe(
      false
    );
    expect(monitorReaches("shop", { any: true }, "pay")).toBe(true);
    expect(monitorReaches("shop", { matchNames: ["pay"] }, "pay")).toBe(true);
    expect(monitorReaches("shop", { matchNames: ["pay"] }, "shop")).toBe(false);
  });
});

describe("selectedServices", () => {
  const web = monitor("web", "shop", {
    selector: { matchLabels: { app: "web" } },
  });
  const services = ok([
    service("web", "shop", { app: "web" }),
    service("web", "pay", { app: "web" }),
    service("db", "shop", { app: "db" }),
  ]);

  it("names the services the selector picks in the namespaces it reaches", () => {
    expect(selectedServices(web, services)).toEqual({
      kind: "services",
      names: ["shop/web"],
    });
    const wide = monitor("web", "shop", {
      selector: { matchLabels: { app: "web" } },
      namespaceSelector: { any: true },
    });
    expect(selectedServices(wide, services)).toEqual({
      kind: "services",
      names: ["shop/web", "pay/web"],
    });
  });

  /** A refused Service list is unknown, never "selects nothing". */
  it("carries a refused service list as unread", () => {
    expect(selectedServices(web, refused())).toEqual({
      kind: "unread",
      reason: "forbidden",
    });
  });

  it("does not count pods for a PodMonitor", () => {
    const pm = readMonitor(
      cr("PodMonitor", "web", "shop", {
        selector: {},
        podMetricsEndpoints: [{ port: "http", interval: "15s" }],
      }),
      "PodMonitor"
    );
    expect(selectedServices(pm, services)).toEqual({ kind: "notCounted" });
    expect(pm.endpoints).toEqual([
      { port: "http", path: "/metrics", interval: "15s" },
    ]);
  });
});

describe("pickedUpBy", () => {
  const prom = (name: string, namespace: string, spec: unknown) =>
    readPrometheus(cr("Prometheus", name, namespace, spec));
  const web = monitor("web", "shop", { selector: {} }, { release: "kps" });

  /** No serviceMonitorSelector means the Prometheus picks nothing up; `{}` means everything in its own namespace. */
  it("reads a missing object selector as none and an empty one as all", () => {
    const none = prom("k8s", "shop", {});
    const all = prom("k8s", "shop", { serviceMonitorSelector: {} });
    expect(pickedUpBy(web, [none], ok([]))).toEqual({ known: true, by: [] });
    expect(pickedUpBy(web, [all], ok([]))).toEqual({
      known: true,
      by: ["k8s"],
    });
  });

  /** A missing namespace selector is the Prometheus's own namespace; an empty one is every namespace. */
  it("limits a Prometheus to its own namespace unless its namespace selector is empty", () => {
    const own = prom("k8s", "monitoring", {
      serviceMonitorSelector: { matchLabels: { release: "kps" } },
    });
    const every = prom("k8s", "monitoring", {
      serviceMonitorSelector: { matchLabels: { release: "kps" } },
      serviceMonitorNamespaceSelector: {},
    });
    expect(pickedUpBy(web, [own], ok([])).by).toEqual([]);
    expect(pickedUpBy(web, [every], ok([])).by).toEqual(["k8s"]);
  });

  /** Namespace labels decide, so unread namespaces make the answer unknown rather than "not picked up". */
  it("says unknown when the namespace labels it needs were not read", () => {
    const labelled = prom("k8s", "monitoring", {
      serviceMonitorSelector: {},
      serviceMonitorNamespaceSelector: { matchLabels: { team: "shop" } },
    });
    const namespaces = ok<NamespaceInfo>([
      {
        name: "shop",
        uid: "n1",
        status: "Active",
        labels: { team: "shop" },
        createdAt: null,
      },
    ]);
    expect(pickedUpBy(web, [labelled], namespaces)).toEqual({
      known: true,
      by: ["k8s"],
    });
    expect(pickedUpBy(web, [labelled], refused())).toEqual({
      known: false,
      by: [],
      reason: "forbidden",
    });
  });
});

describe("scrapeOf", () => {
  const web = monitor("web", "shop", { selector: {} });
  const targets: TargetsRead = {
    state: "read",
    targets: [
      {
        scrapePool: "serviceMonitor/shop/web/0",
        scrapeUrl: "http://a",
        health: "up",
        lastError: "",
        lastScrape: "2026-09-12T08:00:00Z",
        labels: {},
      },
      {
        scrapePool: "serviceMonitor/shop/web/0",
        scrapeUrl: "http://b",
        health: "down",
        lastError: "connection refused",
        lastScrape: "2026-09-12T08:00:05Z",
        labels: {},
      },
      {
        scrapePool: "serviceMonitor/shop/webhook/0",
        scrapeUrl: "http://c",
        health: "up",
        lastError: "",
        lastScrape: null,
        labels: {},
      },
      {
        scrapePool: "podMonitor/shop/web/0",
        scrapeUrl: "http://d",
        health: "up",
        lastError: "",
        lastScrape: null,
        labels: {},
      },
    ],
  };

  /** The pool name is the tie; `web` must not absorb `webhook`, nor a PodMonitor of the same name. */
  it("counts only the pools written for this monitor, with the newest scrape and the first error", () => {
    expect(poolPrefix(web)).toBe("serviceMonitor/shop/web/");
    expect(scrapeOf(web, targets)).toEqual({
      state: "read",
      up: 1,
      down: 1,
      unknown: 0,
      lastError: "connection refused",
      lastScrape: "2026-09-12T08:00:05Z",
    });
  });

  it("passes the other two states through untouched", () => {
    expect(scrapeOf(web, { state: "notConnected" })).toEqual({
      state: "notConnected",
    });
    expect(scrapeOf(web, { state: "unanswered", reason: "502" })).toEqual({
      state: "unanswered",
      reason: "502",
    });
  });
});

describe("rowsOf", () => {
  const prom = readPrometheus(
    cr(
      "Prometheus",
      "k8s",
      "shop",
      { serviceMonitorSelector: {}, replicas: 2 },
      {},
      { availableReplicas: 2 }
    )
  );
  const services = ok([service("web", "shop", { app: "web" })]);
  const targets: TargetsRead = {
    state: "read",
    targets: [
      {
        scrapePool: "serviceMonitor/shop/web/0",
        scrapeUrl: "http://a",
        health: "up",
        lastError: "",
        lastScrape: null,
        labels: {},
      },
    ],
  };

  it("puts the broken monitors first and says which way each is broken", () => {
    const fine = monitor("web", "shop", {
      selector: { matchLabels: { app: "web" } },
    });
    const empty = monitor("nothing", "shop", {
      selector: { matchLabels: { app: "gone" } },
    });
    const orphan = monitor("orphan", "pay", { selector: {} });
    const rows = rowsOf(
      [fine, empty, orphan],
      [prom],
      services,
      ok([]),
      targets
    );
    // Both broken, so namespace then name decides: pay before shop.
    expect(rows.map((row) => row.monitor.name)).toEqual([
      "orphan",
      "nothing",
      "web",
    ]);
    // A monitor that selects nothing has nothing to scrape, so "no targets" is not a second finding on top.
    expect(rows[0].findings.map((f) => f.kind)).toEqual([
      "selectsNothing",
      "notPickedUp",
    ]);
    expect(rows[1].findings.map((f) => f.kind)).toEqual(["selectsNothing"]);
    expect(rows[2].findings).toEqual([]);
    expect(rows[2].worst).toBeNull();
  });

  /** With no Prometheus connected the scrape column is unchecked, and a monitor with nothing else wrong is not a finding. */
  it("does not invent a finding when the scrape truth is not available", () => {
    const fine = monitor("web", "shop", {
      selector: { matchLabels: { app: "web" } },
    });
    const [row] = rowsOf([fine], [prom], services, ok([]), {
      state: "notConnected",
    });
    expect(row.scrape).toEqual({ state: "notConnected" });
    expect(row.findings).toEqual([]);
  });

  it("carries a down target with Prometheus's own words", () => {
    const fine = monitor("web", "shop", {
      selector: { matchLabels: { app: "web" } },
    });
    const [row] = rowsOf([fine], [prom], services, ok([]), {
      state: "read",
      targets: [
        {
          scrapePool: "serviceMonitor/shop/web/0",
          scrapeUrl: "http://a",
          health: "down",
          lastError: "context deadline exceeded",
          lastScrape: null,
          labels: {},
        },
      ],
    });
    expect(row.findings).toEqual([
      {
        kind: "targetsDown",
        severity: "err",
        down: 1,
        total: 1,
        lastError: "context deadline exceeded",
      },
    ]);
    expect(row.worst).toBe("err");
  });
});
