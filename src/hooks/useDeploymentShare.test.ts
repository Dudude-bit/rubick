// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import type { T } from "@/i18n/useT";
import type { DeploymentInfo, ReplicaSetInfo } from "@/generated/types";
import {
  deploymentStatsOf,
  deploymentStatusOf,
  revisionsSection,
  useDeploymentShare,
} from "./useDeploymentShare";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const deployment = {
  name: "payments",
  namespace: "shop",
  replicas: { desired: 3, ready: 2, updated: 3, available: 2 },
  strategy: "RollingUpdate",
  containers: [
    {
      name: "app",
      image: "registry.example/shop/payments:2.21.0",
      phase: "app",
    },
  ],
  initContainers: [],
} as unknown as DeploymentInfo;

const revisions = [
  {
    name: "payments-6f9d8c",
    namespace: "shop",
    revision: "4",
    currentRevision: "4",
    replicas: { desired: 3, current: 3, ready: 2, available: 2 },
    containers: [{ image: "registry.example/shop/payments:2.21.0" }],
    createdAt: "2026-09-25T10:00:00Z",
  },
  {
    name: "payments-5a1b2c",
    namespace: "shop",
    revision: "3",
    currentRevision: "4",
    replicas: { desired: 0, current: 0, ready: 0, available: 0 },
    containers: [{ image: "registry.example/shop/payments:2.19.0" }],
    createdAt: "2026-09-20T10:00:00Z",
  },
] as unknown as ReplicaSetInfo[];

describe("what the Deployment page adds to Share", () => {
  /** The bar the reader watches, replicas ready over desired, has to survive into the file. */
  it("carries ready over desired as a stat, not just a colour", () => {
    const stats = deploymentStatsOf(deployment, revisions, t);
    expect(stats).toContainEqual(
      expect.objectContaining({ value: "2/3", role: "warn" })
    );
  });

  /** The revision a rollout landed on is the fact a rollback question starts from. */
  it("names the live revision among the stats", () => {
    const stats = deploymentStatsOf(deployment, revisions, t);
    const revisionStat = stats.find(
      (stat) => stat.label === "columns.revision"
    );
    expect(revisionStat?.value).toBe("4");
    expect(revisionStat?.ref).toMatchObject({ stem: "payments-6f9d8c" });
  });

  /** Every ReplicaSet the Revisions tab lists, with the tag that changed between them. */
  it("lists both revisions with their ready count and image tag", () => {
    const section = revisionsSection(revisions, "2026-09-25T12:00:00Z", t);
    expect(section.count).toBe(2);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "4" },
            { text: "2/3" },
            { text: "2.21.0" },
            { text: "2h" },
          ],
        },
        {
          cells: [
            { text: "3" },
            { text: "0/0" },
            { text: "2.19.0" },
            { text: "5d" },
          ],
        },
      ],
    });
  });

  /** A rollout in flight says so beside the ready count, as the badge does. */
  it("says rolling out when the page's own rollout check is true", () => {
    const status = deploymentStatusOf(deployment.replicas, true, t);
    expect(status.text).toContain("action.rollingOut");
    expect(status.role).toBe("pending");
  });

  /**
   * The wiring itself: removing the pods table or the ready stat from what
   * the hook returns must fail this, not just the pure builders above.
   */
  it("puts the ready stat and a pods table in what the hook hands to Share", () => {
    const pods = [
      {
        name: "payments-abc",
        namespace: "shop",
        status: { display: "Running" },
        restartCount: 0,
        containers: [{ ready: true, state: { type: "running" } }],
        initContainers: [],
      },
    ] as unknown as import("@/generated/types").PodInfo[];
    const { result } = renderHook(() =>
      useDeploymentShare(deployment, revisions, pods, null, false)
    );
    const contribution = result.current();
    expect(contribution.stats).toContainEqual(
      expect.objectContaining({ value: "2/3" })
    );
    const podsSection = contribution.sections?.find((s) => s.id === "pods");
    expect(podsSection?.count).toBe(1);
  });
});
