// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import type { T } from "@/i18n/useT";
import type { DaemonSetDetailInfo, PodInfo } from "@/generated/types";
import {
  daemonSetStatsOf,
  daemonSetStatusOf,
  useDaemonSetShare,
} from "./useDaemonSetShare";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const daemonSet = {
  name: "node-exporter",
  namespace: "monitoring",
  desired: 4,
  current: 4,
  ready: 3,
  upToDate: 2,
  available: 3,
  updateStrategy: "RollingUpdate",
  containers: [
    {
      name: "exporter",
      image: "registry.example/prom/node-exporter:1.7.0",
      phase: "app",
    },
  ],
  initContainers: [],
} as unknown as DaemonSetDetailInfo;

describe("what the DaemonSet page adds to Share", () => {
  /** How many nodes actually have a ready pod is the number a colleague came for. */
  it("carries ready over desired nodes as a stat", () => {
    const stats = daemonSetStatsOf(daemonSet, t);
    expect(stats).toContainEqual(
      expect.objectContaining({ label: "columns.ready", value: "3/4" })
    );
  });

  /** Ready and on the current spec are two different bars on the page; the file keeps both. */
  it("carries how many are on the current spec as its own stat", () => {
    const stats = daemonSetStatsOf(daemonSet, t);
    expect(stats).toContainEqual(
      expect.objectContaining({ label: "share.wlUpToDate", value: "2/4" })
    );
  });

  /** A rollout in flight says so beside the ready count, matching the page's badge. */
  it("says rolling out when fewer nodes are updated than desired", () => {
    const status = daemonSetStatusOf(3, 4, true, t);
    expect(status.text).toContain("action.rollingOut");
  });

  /** The wiring itself: dropping the pods table from the hook's return must fail this. */
  it("puts the ready stat and a pods table in what the hook hands to Share", () => {
    const pods = [
      {
        name: "node-exporter-abc",
        namespace: "monitoring",
        status: { display: "Running" },
        restartCount: 0,
        containers: [{ ready: true, state: { type: "running" } }],
        initContainers: [],
      },
    ] as unknown as PodInfo[];
    const { result } = renderHook(() =>
      useDaemonSetShare(daemonSet, pods, null)
    );
    const contribution = result.current();
    expect(contribution.stats).toContainEqual(
      expect.objectContaining({ value: "3/4" })
    );
    const podsSection = contribution.sections?.find((s) => s.id === "pods");
    expect(podsSection?.count).toBe(1);
  });
});
