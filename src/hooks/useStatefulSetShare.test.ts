// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import type { T } from "@/i18n/useT";
import type { PodInfo, StatefulSetDetailInfo } from "@/generated/types";
import {
  statefulSetStatsOf,
  statefulSetStatusOf,
  useStatefulSetShare,
} from "./useStatefulSetShare";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const statefulSet = {
  name: "postgres",
  namespace: "data",
  replicas: { desired: 3, current: 2, ready: 2, updated: 2 },
  serviceName: "postgres-headless",
  containers: [
    {
      name: "postgres",
      image: "registry.example/data/postgres:16.2",
      phase: "app",
    },
  ],
  initContainers: [],
} as unknown as StatefulSetDetailInfo;

describe("what the StatefulSet page adds to Share", () => {
  /** Ordinals come up one at a time; ready over desired is the number that says how far along. */
  it("carries ready over desired as a stat", () => {
    const stats = statefulSetStatsOf(statefulSet, t);
    expect(stats).toContainEqual(
      expect.objectContaining({ label: "columns.ready", value: "2/3" })
    );
  });

  /** No governing service means the stable network identity the kind exists for does not resolve. */
  it("warns when there is no governing service, as the page's fact block does", () => {
    const stats = statefulSetStatsOf(
      { ...statefulSet, serviceName: null } as StatefulSetDetailInfo,
      t
    );
    const service = stats.find(
      (stat) => stat.label === "columns.governingService"
    );
    expect(service?.role).toBe("warn");
  });

  it("takes its status role from the same ready/desired comparison as the badge", () => {
    const status = statefulSetStatusOf(2, 3, t);
    expect(status.role).toBe("pending");
  });

  /** The wiring itself: dropping the pods table from the hook's return must fail this. */
  it("puts the ready stat and a pods table in what the hook hands to Share", () => {
    const pods = [
      {
        name: "postgres-0",
        namespace: "data",
        status: { display: "Running" },
        restartCount: 0,
        containers: [{ ready: true, state: { type: "running" } }],
        initContainers: [],
      },
    ] as unknown as PodInfo[];
    const { result } = renderHook(() =>
      useStatefulSetShare(statefulSet, pods, null)
    );
    const contribution = result.current();
    expect(contribution.stats).toContainEqual(
      expect.objectContaining({ value: "2/3" })
    );
    const podsSection = contribution.sections?.find((s) => s.id === "pods");
    expect(podsSection?.count).toBe(1);
  });
});
