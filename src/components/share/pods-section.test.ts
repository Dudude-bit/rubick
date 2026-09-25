import { describe, expect, it } from "vitest";

import type { T } from "@/i18n/useT";
import type { PodInfo } from "@/generated/types";
import { podsSection } from "./pods-section";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const pod = (name: string, ready: boolean, restarts = 0) =>
  ({
    name,
    namespace: "shop",
    status: { display: ready ? "Running" : "CrashLoopBackOff" },
    restartCount: restarts,
    containers: [{ ready, state: { type: "running" } }],
    initContainers: [],
  }) as unknown as PodInfo;

describe("podsSection", () => {
  /** A workload's Pods tab and its shared file have to agree on how many are ready. */
  it("draws each pod as a row with its readiness and restarts", () => {
    const section = podsSection(
      { pods: [pod("payments-abc", true), pod("payments-def", false, 3)] },
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
    const section = podsSection({ pods: [], error: new Error("forbidden") }, t);
    expect(section.unread).toBe("empty.couldNotReadWorkloadPods");
  });
});
