/**
 * The failure a connection test cannot catch.
 *
 * A probe proves the address speaks PromQL. It does not prove the Prometheus
 * behind it scrapes *this* cluster — so pointing the app at an organisation's
 * central one produces a healthy connection and charts about somebody else's
 * pods, every number real and none of them yours.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { listNodes: vi.fn(), prometheusQuery: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { coverage, verdict } from "./coverage";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

const t: T = (section, key, values) => translate("en", section, key, values);

const node = (name: string) => ({ name }) as never;
const series = (names: string[]) =>
  names.map((name) => ({ labels: { node: name }, points: [] }));

/** Every family present, so a test can be about the node comparison alone. */
const familiesPresent = () => [{ labels: {}, points: [] }];

beforeEach(() => {
  vi.mocked(commands.prometheusQuery).mockReset();
  vi.mocked(commands.listNodes).mockReset();
});

describe("whether this Prometheus is watching this cluster", () => {
  it("matches the cluster's nodes against what it scrapes", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("n1"), node("n2")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? series(["n1", "n2"])
        : familiesPresent()
    );

    const found = await coverage();
    expect(found.matched).toBe(2);
    expect(found.unseen).toEqual([]);
    expect(verdict(found, t)).toMatchObject({ tone: "ok" });
  });

  /** The one this page exists for. */
  it("says so when it knows none of this cluster's nodes", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("n1"), node("n2")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? series(["other-1", "other-2"])
        : familiesPresent()
    );

    const found = await coverage();
    expect(found.matched).toBe(0);
    expect(found.foreign).toEqual(["other-1", "other-2"]);
    expect(verdict(found, t)).toMatchObject({ tone: "err" });
  });

  /**
   * A node is `ip-10-0-1-4.eu-west-1.compute.internal` to Kubernetes and
   * often `ip-10-0-1-4` to a scrape target. Comparing the whole string would
   * report every EKS cluster as unwatched.
   */
  it("compares on the first label, which is where the spellings agree", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([
      node("ip-10-0-1-4.eu-west-1.compute.internal"),
    ]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? series(["ip-10-0-1-4"])
        : familiesPresent()
    );

    expect((await coverage()).matched).toBe(1);
  });

  /**
   * The row answers "what is actually there" without a click into the graph
   * UI: each family carries its own series count, read off the same
   * `count()` query that already decided presence.
   */
  it("hands each family's series count to the row", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("n1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? series(["n1"])
        : query.includes("container_cpu_usage_seconds_total")
          ? [{ labels: {}, points: [{ t: 0, v: 1234 }] }]
          : [{ labels: {}, points: [{ t: 0, v: 7 }] }]
    );

    const found = await coverage();
    expect(found.series["container_cpu_usage_seconds_total"]).toBe(1234);
    expect(found.series["kubelet_volume_stats_used_bytes"]).toBe(7);
    expect(found.missing).toEqual([]);
  });

  /** Scraping more than this cluster is normal, not a fault. */
  it("does not call a shared Prometheus broken", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("n1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? series(["n1", "someone-else"])
        : familiesPresent()
    );

    const found = await coverage();
    expect(found.foreign).toEqual(["someone-else"]);
    expect(verdict(found, t)).toMatchObject({ tone: "ok" });
  });

  /**
   * An absent metric family answers every query with an empty series, and an
   * empty series is drawn as a flat chart — the same picture as a quiet pod.
   */
  it("names a family the app queries and this Prometheus has none of", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("n1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) => {
      if (query.includes("kube_node_info")) return series(["n1"]);
      if (query.includes("kubelet_volume_stats_used_bytes")) return [];
      return familiesPresent();
    });

    const found = await coverage();
    expect(found.missing.map((entry) => entry.metric)).toEqual([
      "kubelet_volume_stats_used_bytes",
    ]);
  });

  /** A refused query is not an absence, and must not read as one. */
  it("says it could not tell when kube-state-metrics is not scraped", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("n1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? Promise.reject(new Error("no such metric"))
        : familiesPresent()
    );

    const found = await coverage();
    expect(t("readings", found.problem!)).toContain("kube_node_info");
    expect(verdict(found, t)).toMatchObject({ tone: "warn" });
  });
});

describe("a Prometheus that carries no node names", () => {
  /**
   * The panel's own worst finding, reported from a real cluster: a
   * VictoriaMetrics scraping cAdvisor and kube-state-metrics answered
   * `kube_node_info` with nothing, and the panel said "This Prometheus is not
   * watching this cluster" — while three of the four families held hundreds
   * of series from that very cluster. Silence about node names means the
   * question cannot be answered, not that the answer is no.
   */
  /**
   * Which label carries the node name is the scrape config's choice —
   * `NODE_LABELS` lists the three this app reads — so both queries must group
   * by more than `node`, or they discard the name in exactly the setups that
   * need them.
   *
   * This asserts the query text, not the result: the mock hands back whatever
   * labels it is told to and does not implement `by (...)`, so a test written
   * against its answer would pass with either grouping. The query string is
   * the only part of this a unit test can actually hold.
   */
  it("groups by every label a node name lands in", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("talos-1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.startsWith("count by") ? [] : familiesPresent()
    );

    await coverage();
    const grouped = vi
      .mocked(commands.prometheusQuery)
      .mock.calls.map(([query]) => query)
      .filter((query) => query.startsWith("count by"));

    expect(grouped).toHaveLength(2);
    for (const query of grouped) {
      expect(query).toContain("by (node, instance)");
    }
  });

  /**
   * Found by running the real thing rather than by reading it. cAdvisor's
   * `instance` is routinely `10.0.0.4:10250`, and `shortName` reduces that to
   * "10" — a name no cluster has. Trusted in both directions it would produce
   * exactly the false accusation this whole change removes.
   */
  it("does not turn an ip:port instance into a foreign cluster", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("talos-1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? []
        : query.startsWith("count by")
          ? [{ labels: { instance: "10.0.0.4:10250" }, points: [] }]
          : familiesPresent()
    );

    const found = await coverage();
    expect(found.foreign).toEqual([]);
    expect(found.unseen).toEqual([]);
    expect(t("readings", found.problem!)).toContain("cannot be established");
  });

  it("reads a name that arrived under instance rather than node", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("talos-1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? []
        : query.startsWith("count by")
          ? [{ labels: { instance: "talos-1" }, points: [] }]
          : familiesPresent()
    );

    const found = await coverage();
    expect(found.problem).toBeNull();
    expect(found.matched).toBe(1);
  });

  /** One query on an ordinary cluster; the second is asked only when needed. */
  it("does not ask cAdvisor when kube_node_info answered", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("n1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info") ? series(["n1"]) : familiesPresent()
    );

    await coverage();
    const asked = vi
      .mocked(commands.prometheusQuery)
      .mock.calls.map(([query]) => query);
    expect(
      asked.some(
        (query) =>
          query.startsWith("count by") &&
          query.includes("container_cpu_usage_seconds_total")
      )
    ).toBe(false);
  });

  it("falls back to cAdvisor's node label before giving up", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("talos-1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.includes("kube_node_info")
        ? []
        : query.includes("container_cpu_usage_seconds_total") &&
            query.startsWith("count by")
          ? series(["talos-1"])
          : familiesPresent()
    );

    const found = await coverage();
    expect(found.problem).toBeNull();
    expect(found.matched).toBe(1);
    expect(found.unseen).toEqual([]);
  });

  it("says it cannot tell rather than blaming the cluster", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([node("talos-1")]);
    vi.mocked(commands.prometheusQuery).mockImplementation(async (query) =>
      query.startsWith("count by") ? [] : familiesPresent()
    );

    const found = await coverage();
    expect(t("readings", found.problem!)).toContain("cannot be established");
    // Not reported as a cluster it does not watch: `unseen` drives that
    // sentence, and an unanswerable question must not fill it.
    expect(found.unseen).toEqual([]);
    expect(found.matched).toBe(0);
  });
});
