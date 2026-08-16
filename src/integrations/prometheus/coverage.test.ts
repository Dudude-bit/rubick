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
    expect(verdict(found)).toMatchObject({ tone: "ok" });
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
    expect(verdict(found)).toMatchObject({ tone: "err" });
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
    expect(verdict(found)).toMatchObject({ tone: "ok" });
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
    expect(found.problem).toContain("kube_node_info");
    expect(verdict(found)).toMatchObject({ tone: "warn" });
  });
});
