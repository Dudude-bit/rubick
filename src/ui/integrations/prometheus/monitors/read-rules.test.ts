import { describe, expect, it, vi } from "vitest";

const getPrometheusConnection = vi.fn();
const prometheusRules = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    getPrometheusConnection: () => getPrometheusConnection(),
    prometheusRules: () => prometheusRules(),
  },
}));

import { readRules } from "./data";

describe("reading the rules a Prometheus has loaded", () => {
  /**
   * A refused read is not a Prometheus with no rules: read as an empty list
   * it becomes "picked up and never loaded" on every rule object on the
   * page, in red, about a read nobody was allowed to make.
   */
  it("carries the refusal rather than answering with no rules", async () => {
    getPrometheusConnection.mockResolvedValue({ url: "http://p:9090" });
    prometheusRules.mockRejectedValue(new Error("prometheus refused"));

    const read = await readRules();
    expect(read.state).toBe("unanswered");
    expect(read).toMatchObject({ reason: expect.stringMatching(/refused/) });
  });

  /** And a Prometheus nobody connected is its own state, not a failure. */
  it("says nothing is connected when nothing is", async () => {
    getPrometheusConnection.mockResolvedValue(null);
    expect((await readRules()).state).toBe("notConnected");
  });

  it("hands back the rules when the read answered", async () => {
    getPrometheusConnection.mockResolvedValue({ url: "http://p:9090" });
    prometheusRules.mockResolvedValue([]);
    expect(await readRules()).toEqual({ state: "read", rules: [] });
  });
});
