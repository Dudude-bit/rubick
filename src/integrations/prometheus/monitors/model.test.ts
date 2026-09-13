import { describe, expect, it } from "vitest";

import type {
  CustomResourceInfo,
  NamespaceInfo,
  ServiceInfo,
} from "@/generated/types";
import type { PromSeries } from "@/generated/types";
import {
  downSince,
  groupOf,
  hintFor,
  lanesOf,
  monitorReaches,
  pickedUpBy,
  poolPrefix,
  readMonitor,
  readPrometheus,
  rowsOf,
  scrapeOf,
  selectedServices,
  selectorMatches,
  sharedPrefix,
  upQuery,
  type Kind,
  type Monitor,
  type PrometheusInstance,
  type Read,
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
const kind = (items: PrometheusInstance[]): Kind<PrometheusInstance> => ({
  state: "read",
  items,
});

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
    expect(pickedUpBy(web, kind([none]), ok([]))).toEqual({
      state: "judged",
      by: [],
    });
    expect(pickedUpBy(web, kind([all]), ok([]))).toEqual({
      state: "judged",
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
    expect(pickedUpBy(web, kind([own]), ok([]))).toMatchObject({ by: [] });
    expect(pickedUpBy(web, kind([every]), ok([]))).toMatchObject({
      by: ["k8s"],
    });
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
    expect(pickedUpBy(web, kind([labelled]), namespaces)).toEqual({
      state: "judged",
      by: ["k8s"],
    });
    expect(pickedUpBy(web, kind([labelled]), refused())).toEqual({
      state: "unknown",
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
    expect(scrapeOf(web, targets)).toMatchObject({
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
      kind([prom]),
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
    const [row] = rowsOf([fine], kind([prom]), services, ok([]), {
      state: "notConnected",
    });
    expect(row.scrape).toEqual({ state: "notConnected" });
    expect(row.findings).toEqual([]);
  });

  it("carries a down target with Prometheus's own words", () => {
    const fine = monitor("web", "shop", {
      selector: { matchLabels: { app: "web" } },
    });
    const [row] = rowsOf([fine], kind([prom]), services, ok([]), {
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

describe("a partial install", () => {
  const prom = readPrometheus(
    cr("Prometheus", "k8s", "shop", { serviceMonitorSelector: {} })
  );
  const services = ok([service("web", "shop", { app: "web" })]);
  const fine = monitor("web", "shop", {
    selector: { matchLabels: { app: "web" } },
  });

  /**
   * The lie this exists to stop: a refused or missing Prometheus list
   * collapsing into an empty one, and every monitor turning red with "no
   * Prometheus picks it up". Would break if `rowsOf` took a bare array
   * again, or if the two non-read states fell through to "judged".
   */
  it("does not call a monitor unpicked when the Prometheus objects could not be read", () => {
    const [row] = rowsOf(
      [fine],
      { state: "unread", reason: "forbidden" },
      services,
      ok([]),
      { state: "notConnected" }
    );
    expect(row.pickedUp).toEqual({
      state: "unknown",
      by: [],
      reason: "forbidden",
    });
    expect(row.findings.map((f) => f.kind)).toEqual(["pickedUpUnknown"]);
    expect(row.worst).toBe("warn");
  });

  it("does not judge pick-up at all when the Prometheus CRD is not installed", () => {
    const [row] = rowsOf([fine], { state: "absent" }, services, ok([]), {
      state: "notConnected",
    });
    expect(row.pickedUp).toEqual({ state: "noKind" });
    expect(row.findings).toEqual([]);
    expect(row.worst).toBeNull();
  });

  /** The same monitor with the kind present and nobody matching is a real finding. */
  it("still calls a monitor unpicked when the objects were read and none matches", () => {
    const [row] = rowsOf([fine], kind([]), services, ok([]), {
      state: "notConnected",
    });
    expect(row.pickedUp).toEqual({ state: "judged", by: [] });
    expect(row.findings.map((f) => f.kind)).toEqual(["notPickedUp"]);
  });

  /** Nothing can pick it up and nothing scrapes it: waiting, not fine. */
  it("still says a monitor with no pool is waiting when pick-up could not be judged", () => {
    const [row] = rowsOf([fine], { state: "absent" }, services, ok([]), {
      state: "read",
      targets: [],
    });
    expect(row.findings.map((f) => f.kind)).toEqual(["noTargets"]);
    expect(groupOf(row)).toBe("waiting");
  });

  /** Would break if the first finding pushed, rather than the worst, named the row. */
  it("puts the worst finding first whatever order the questions were asked in", () => {
    const [row] = rowsOf(
      [fine],
      { state: "unread", reason: "forbidden" },
      services,
      ok([]),
      {
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
      }
    );
    expect(row.findings.map((f) => f.kind)).toEqual([
      "targetsDown",
      "pickedUpUnknown",
    ]);
  });

  it("keeps a picked-up monitor without a pool as waiting", () => {
    const [row] = rowsOf([fine], kind([prom]), services, ok([]), {
      state: "read",
      targets: [],
    });
    expect(row.findings.map((f) => f.kind)).toEqual(["noTargets"]);
    expect(groupOf(row)).toBe("waiting");
  });
});

describe("the ladder", () => {
  it("folds the prefix a chart put on most of its monitors, and only then", () => {
    expect(
      sharedPrefix([
        "kps-kube-prometheus-stack-apiserver",
        "kps-kube-prometheus-stack-coredns",
        "kps-kube-prometheus-stack-kubelet",
        "kps-kube-state-metrics",
        "prometheus",
      ])
    ).toBe("kps-kube-prometheus-stack-");
    expect(sharedPrefix(["a-b", "a-c", "a-d"])).toBeNull();
    expect(sharedPrefix(["web", "api"])).toBeNull();
  });
});

describe("the heartbeat", () => {
  const target = (job: string, instance: string) => ({
    scrapePool: "serviceMonitor/shop/web/0",
    scrapeUrl: `http://${instance}/metrics`,
    health: "up",
    lastError: "",
    lastScrape: null,
    labels: { job, instance },
  });

  /** The pool is not a label on the series, so `up` is asked by the labels Prometheus put on the targets. */
  it("asks for up by job and instance, escaped, and asks nothing for no target", () => {
    expect(
      upQuery([target("web", "10.0.0.1:80"), target("web", "10.0.0.2:80")])
    ).toBe('up{job=~"web",instance=~"10\\.0\\.0\\.1:80|10\\.0\\.0\\.2:80"}');
    expect(upQuery([])).toBeNull();
  });

  it("lays samples into minute cells per instance and leaves a gap where none landed", () => {
    const from = 1_000_000;
    const series: PromSeries[] = [
      {
        labels: { instance: "b" },
        points: [
          { t: from, v: 1 },
          { t: from + 60_000, v: 0 },
          { t: from + 180_000, v: 1 },
        ],
      },
      { labels: { instance: "a" }, points: [{ t: from + 120_000, v: 0 }] },
    ];
    const lanes = lanesOf(series, from, from + 240_000, 60_000);
    expect(lanes.map((lane) => lane.instance)).toEqual(["a", "b"]);
    expect(lanes[0].job).toBe("");
    expect(lanes[1].cells).toEqual(["up", "down", "none", "up"]);
    expect(lanes[0].cells).toEqual(["none", "none", "down", "none"]);
  });

  it("dates a current outage from the first down cell after the last up", () => {
    const from = 1_000_000;
    const lanes = lanesOf(
      [
        {
          labels: { instance: "a" },
          points: [
            { t: from, v: 1 },
            { t: from + 60_000, v: 0 },
            { t: from + 120_000, v: 0 },
          ],
        },
      ],
      from,
      from + 180_000,
      60_000
    );
    expect(downSince(lanes, from, 60_000)).toBe(from + 60_000);
    const healthy = lanesOf(
      [{ labels: { instance: "a" }, points: [{ t: from + 120_000, v: 1 }] }],
      from,
      from + 180_000,
      60_000
    );
    expect(downSince(healthy, from, 60_000)).toBeNull();
  });
});

describe("the likely cause", () => {
  const services = ok([service("web", "shop", { app: "web" })]);
  const prom = readPrometheus(
    cr("Prometheus", "k8s", "shop", { serviceMonitorSelector: {} })
  );
  const down = (lastError: string) => {
    const web = monitor("web", "shop", {
      selector: { matchLabels: { app: "web" } },
      endpoints: [{ port: "http-metrics", path: "/metrics" }],
    });
    const [row] = rowsOf([web], kind([prom]), services, ok([]), {
      state: "read",
      targets: [
        {
          scrapePool: "serviceMonitor/shop/web/0",
          scrapeUrl: "https://172.30.1.2:10257/metrics",
          health: "down",
          lastError,
          lastScrape: null,
          labels: {},
        },
      ],
    });
    return row;
  };

  it("names the kubeadm loopback bind from Prometheus's dial error", () => {
    expect(
      hintFor(
        down(
          'Get "https://172.30.1.2:10257/metrics": dial tcp 172.30.1.2:10257: connect: connection refused'
        )
      )
    ).toEqual({
      key: "loopback",
      port: "10257",
      component: "kube-controller-manager",
    });
  });

  it("reads a 404 as the path, a 403 as credentials, and says nothing for words it does not know", () => {
    expect(hintFor(down("server returned HTTP status 404 Not Found"))).toEqual({
      key: "notFound",
      path: "/metrics",
      port: "http-metrics",
    });
    expect(hintFor(down("server returned HTTP status 403 Forbidden"))).toEqual({
      key: "unauthorized",
    });
    expect(hintFor(down("something new"))).toBeNull();
  });

  it("points a selector that matches nothing at the labels", () => {
    const empty = monitor("nothing", "shop", {
      selector: { matchLabels: { app: "gone" } },
    });
    const [row] = rowsOf([empty], kind([prom]), services, ok([]), {
      state: "notConnected",
    });
    expect(hintFor(row)).toEqual({
      key: "selectsNothing",
      selector: "app=gone",
      namespace: "shop",
    });
  });
});
