import { describe, expect, it, vi } from "vitest";

const prometheusRules = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: { prometheusRules: () => prometheusRules() },
}));

import type { AlertRule } from "@/generated/types";
import { alertsAboutObject } from "./client";

const rule = (over: Partial<AlertRule> = {}): AlertRule =>
  ({
    group: "kubernetes-apps",
    file: "/rules/monitoring-apps.yaml",
    name: "KubePodCrashLooping",
    state: "firing",
    health: "ok",
    lastError: "",
    query: "up == 0",
    durationSeconds: 900,
    lastEvaluation: null,
    labels: {},
    annotations: {},
    alerts: [
      {
        state: "firing",
        activeAt: "2026-09-12T20:00:00Z",
        value: "1",
        labels: { namespace: "shop", deployment: "payments" },
        annotations: { summary: "payments is unhappy" },
      },
    ],
    ...over,
  }) as AlertRule;

describe("what is firing about one object", () => {
  /**
   * The whole point of the block on a workload page, and nothing exercised
   * it: the filtering happens here, so a reading that let another object's
   * alert through — or dropped this one's — showed on the page and in no
   * test.
   */
  it("keeps the alerts whose labels name this object and no others", async () => {
    prometheusRules.mockResolvedValue([rule()]);

    const read = await alertsAboutObject.read();

    expect(
      alertsAboutObject.pick(read, {
        kind: "Deployment",
        name: "payments",
        namespace: "shop",
      })
    ).toHaveLength(1);
    expect(
      alertsAboutObject.pick(read, {
        kind: "Deployment",
        name: "checkout",
        namespace: "shop",
      })
    ).toHaveLength(0);
  });

  /**
   * The read is the collection, not one object's slice — a second object
   * asks the picking, not the evaluator. Reading per object put every
   * alerting rule in the cluster on the wire for each page and each peek.
   */
  it("reads the evaluator once however many objects are asked about", async () => {
    prometheusRules.mockResolvedValue([rule()]);

    const read = await alertsAboutObject.read();
    for (const name of ["payments", "checkout", "search"]) {
      alertsAboutObject.pick(read, {
        kind: "Deployment",
        name,
        namespace: "shop",
      });
    }

    expect(prometheusRules).toHaveBeenCalledTimes(1);
  });

  /** A read that fails is not a workload with nothing firing about it. */
  it("lets a refused read reach the caller", async () => {
    prometheusRules.mockRejectedValue(new Error("prometheus refused"));
    await expect(alertsAboutObject.read()).rejects.toThrow(/refused/);
  });
});
