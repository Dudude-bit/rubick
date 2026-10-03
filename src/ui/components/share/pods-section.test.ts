import { describe, expect, it } from "vitest";

import type { T } from "@/i18n/useT";
import type { PodInfo } from "@/generated/types";
import type { NodeSilence } from "@/lib/node-reporting";
import { podsSection } from "./pods-section";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const AT = "2026-09-28T23:15:00Z";
const NONE = new Map<string, NodeSilence>();

const pod = (name: string, ready: boolean, restarts = 0, nodeName = "n1") =>
  ({
    name,
    namespace: "shop",
    nodeName,
    status: { display: ready ? "Running" : "CrashLoopBackOff" },
    restartCount: restarts,
    containers: [{ ready, state: { type: "running" } }],
    initContainers: [],
  }) as unknown as PodInfo;

describe("podsSection", () => {
  /** A workload's Pods tab and its shared file have to agree on how many are ready. */
  it("draws each pod as a row with its readiness and restarts", () => {
    const section = podsSection(
      {
        pods: [pod("payments-abc", true), pod("payments-def", false, 3)],
        silent: NONE,
        capturedAt: AT,
      },
      t
    );
    expect(section.count).toBe(2);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "payments-abc" },
            { text: "Running", role: "ok" },
            { text: "1/1" },
            { text: "0" },
          ],
        },
        {
          cells: [
            { text: "payments-def" },
            { text: "CrashLoopBackOff", role: "err" },
            { text: "0/1" },
            { text: "3", role: "warn" },
          ],
        },
      ],
    });
  });

  /** A refused pod list and a workload with none running are different answers. */
  it("marks the section unread rather than drawing an empty table on a refusal", () => {
    const section = podsSection(
      {
        pods: [],
        error: new Error("forbidden"),
        silent: NONE,
        capturedAt: AT,
      },
      t
    );
    expect(section.unread).toBe("empty.couldNotReadWorkloadPods");
  });

  /**
   * A pod on a node that stopped reporting is its kubelet's last word: the
   * workload's Pods tab draws it without colour and says so, and the file
   * drew it green `Running`.
   */
  it("draws a pod on a node that stopped reporting without colour, and says why", () => {
    const silent = new Map<string, NodeSilence>([
      ["n2", { node: "n2", since: null, reason: "NodeStatusUnknown" }],
    ]);
    const section = podsSection(
      {
        pods: [pod("payments-abc", true), pod("payments-ghi", true, 0, "n2")],
        silent,
        capturedAt: AT,
      },
      t
    );
    if (section.body.type !== "table") throw new Error("expected a table");
    expect(section.body.rows[0].cells[1]).toEqual({
      text: "Running",
      role: "ok",
    });
    expect(section.body.rows[1].cells[1]).toEqual({
      text: "Running · readings.nodeStoppedReporting(node=n2)",
      role: "neutral",
    });
  });
});
