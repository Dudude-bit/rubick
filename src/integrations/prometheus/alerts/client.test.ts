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

    const mine = await alertsAboutObject({
      kind: "Deployment",
      name: "payments",
      namespace: "shop",
    });
    expect(mine).toHaveLength(1);

    const neighbour = await alertsAboutObject({
      kind: "Deployment",
      name: "checkout",
      namespace: "shop",
    });
    expect(neighbour).toHaveLength(0);
  });

  /** A read that fails is not a workload with nothing firing about it. */
  it("lets a refused read reach the caller", async () => {
    prometheusRules.mockRejectedValue(new Error("prometheus refused"));
    await expect(
      alertsAboutObject({
        kind: "Deployment",
        name: "payments",
        namespace: "shop",
      })
    ).rejects.toThrow(/refused/);
  });
});
