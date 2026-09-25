// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import type { T } from "@/i18n/useT";
import type {
  OwnerReference,
  PodInfo,
  ReplicaSetInfo,
} from "@/generated/types";
import {
  replicaSetStatsOf,
  replicaSetStatusOf,
  useReplicaSetShare,
} from "./useReplicaSetShare";

const t = ((section: string, key: string, values?: Record<string, unknown>) =>
  values
    ? `${section}.${key}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",")})`
    : `${section}.${key}`) as unknown as T;

const replicaSet = {
  name: "payments-6f9d8c",
  namespace: "shop",
  revision: "4",
  currentRevision: "4",
  replicas: { desired: 3, current: 3, ready: 2, available: 2 },
  containers: [
    {
      name: "app",
      image: "registry.example/shop/payments:2.21.0",
      phase: "app",
    },
  ],
  initContainers: [],
} as unknown as ReplicaSetInfo;

const owner = {
  kind: "Deployment",
  name: "payments",
  uid: "u1",
  controller: true,
} as OwnerReference;

describe("what the ReplicaSet page adds to Share", () => {
  /** Ready over desired is the number the page's own badge counts down from. */
  it("carries ready over desired as a stat", () => {
    const stats = replicaSetStatsOf(replicaSet, owner, 0, t);
    expect(stats).toContainEqual(
      expect.objectContaining({ label: "columns.ready", value: "2/3" })
    );
  });

  /** The Deployment this revision belongs to is a fact, with a link back to it. */
  it("names the owning Deployment among the stats", () => {
    const stats = replicaSetStatsOf(replicaSet, owner, 2, t);
    const ownerStat = stats.find((stat) => stat.label === "columns.ownedBy");
    expect(ownerStat?.value).toBe("payments");
    expect(ownerStat?.ref).toMatchObject({
      kind: "Deployment",
      stem: "payments",
    });
  });

  /** A superseded revision reads that way in the file, the same word the badge shows. */
  it("says superseded rather than a ready count once a newer revision exists", () => {
    const status = replicaSetStatusOf("superseded", 0, 0, t);
    expect(status.text).toBe("empty.supersededLower");
  });

  /** The wiring itself: dropping the pods table from the hook's return must fail this. */
  it("puts the ready stat and a pods table in what the hook hands to Share", () => {
    const pods = [
      {
        name: "payments-6f9d8c-x1",
        namespace: "shop",
        status: { display: "Running" },
        restartCount: 0,
        containers: [{ ready: true, state: { type: "running" } }],
        initContainers: [],
      },
    ] as unknown as PodInfo[];
    const { result } = renderHook(() =>
      useReplicaSetShare(replicaSet, "current", owner, 0, pods, null)
    );
    const contribution = result.current();
    expect(contribution.stats).toContainEqual(
      expect.objectContaining({ value: "2/3" })
    );
    const podsSection = contribution.sections?.find((s) => s.id === "pods");
    expect(podsSection?.count).toBe(1);
  });
});
