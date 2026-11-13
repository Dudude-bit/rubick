import { describe, expect, it } from "vite-plus/test";

import type { PodCause } from "@/generated/types";
import type { AttentionItem } from "@/lib/attention";
import { itemsOfRow, problemOfRow, rowProblems } from "./row-items";

const exits: PodCause = {
  says: "exits",
  container: "app",
  restarts: 7,
  run: null,
  until: null,
  later: null,
};

const item = (over: Partial<AttentionItem>): AttentionItem =>
  ({
    key: "k",
    tone: "warn",
    kind: "HorizontalPodAutoscaler",
    name: "web",
    namespace: "shop",
    reason: "TooManyReplicas",
    detail: { says: "said", text: "more than the maximum" },
    opens: { kind: "Deployment", name: "web", namespace: "shop" },
    ...over,
  }) as AttentionItem;

/**
 * The sidebar's problem dot and the list's Ready word read different data.
 * Fails if a workload's row ignores what another object raises against it,
 * or counts the workload's own rollout twice.
 */
describe("the problems a workload's row carries", () => {
  it("finds what an autoscaler holds against the workload it opens", () => {
    const problems = rowProblems([item({})]);
    expect(problemOfRow(problems, "Deployment", "shop", "web")).toEqual({
      tone: "warn",
      n: 1,
      title: "TooManyReplicas: more than the maximum",
    });
    expect(problemOfRow(problems, "Deployment", "shop", "api")).toBeNull();
  });

  it("takes the loudest tone and counts every item, and skips the workload's own", () => {
    const problems = rowProblems([
      item({}),
      item({ key: "b", tone: "err", reason: "FailedGetScale", detail: null }),
      item({ key: "c", kind: "Deployment" }),
    ]);
    expect(problemOfRow(problems, "Deployment", "shop", "web")).toEqual({
      tone: "err",
      n: 2,
      title: "FailedGetScale",
    });
  });
});

/**
 * A pod's page led with its failing liveness probe while its list row was a
 * plain green Running. Fails if a pod's own item does not reach its row, or
 * if a workload's list starts counting its own rollout.
 */
describe("the problems a pod's row carries", () => {
  const probe = item({
    key: "p",
    kind: "Pod",
    name: "web-1",
    reason: "Unhealthy",
    detail: {
      says: "probe",
      failure: {
        container: "web",
        probe: "liveness",
        restarts: 2,
        said: "Liveness probe failed: HTTP probe failed with statuscode: 500",
        since: null,
      },
    },
    opens: { kind: "Pod", name: "web-1", namespace: "shop" },
  });

  it("finds the pod's own probe item by its own kind", () => {
    const problems = rowProblems([probe, item({})], "Pod");
    expect(problemOfRow(problems, "Pod", "shop", "web-1")).toEqual({
      tone: "warn",
      n: 1,
      title:
        "Unhealthy: Liveness probe failed: HTTP probe failed with statuscode: 500",
    });
    expect(problemOfRow(problems, "Deployment", "shop", "web")).toBeNull();
  });

  it("is not counted on a workload's row", () => {
    expect(
      problemOfRow(rowProblems([probe]), "Pod", "shop", "web-1")
    ).toBeNull();
  });
});

const failing = (name: string, over: Partial<AttentionItem> = {}) =>
  item({
    key: name,
    kind: "Pod",
    name,
    reason: "Unhealthy",
    detail: {
      says: "probe",
      failure: {
        container: "repo-server",
        probe: "liveness",
        restarts: 1,
        said: "Liveness probe failed: context deadline exceeded",
        since: null,
      },
    },
    opens: { kind: "Pod", name, namespace: "shop" },
    workload: { kind: "Deployment", name: "web" },
    ...over,
  });

/**
 * argocd-repo-server read a green "Ready 2/2" while both its pods failed
 * their liveness probe. Fails if a workload's row drops its pods' rows, takes
 * another namespace's namesake's, or repeats the cause its own row tells.
 */
describe("a workload's row carries what its pods' rows say", () => {
  it("counts each failing pod on its workload's row, beside what opens it from elsewhere", () => {
    const problems = rowProblems([
      failing("web-1"),
      failing("web-2"),
      failing("web-3", { namespace: "other" }),
      item({}),
    ]);
    expect(problemOfRow(problems, "Deployment", "shop", "web")).toEqual({
      tone: "warn",
      n: 3,
      title: "Unhealthy: Liveness probe failed: context deadline exceeded",
    });
    expect(problemOfRow(problems, "Deployment", "other", "web")?.n).toBe(1);
  });

  it("leaves out a pod whose cause the workload's own row already tells", () => {
    const head = item({
      key: "head",
      tone: "err",
      kind: "Deployment",
      reason: "Unavailable",
      detail: { says: "podsCause", cause: exits, pods: 1, of: 2, said: null },
    });
    const looping = failing("web-1", {
      tone: "err",
      reason: "CrashLoopBackOff",
      detail: { says: "cause", cause: exits, by: null },
    });
    const problems = rowProblems([head, looping, failing("web-2")]);
    expect(problemOfRow(problems, "Deployment", "shop", "web")).toMatchObject({
      tone: "warn",
      n: 1,
    });
  });

  it("gives the peek and the page chip the items the row carries, a pod's for a pod", () => {
    const items = [failing("web-1"), item({})];
    expect(
      itemsOfRow(items, "Deployment", "shop", "web").map(({ key }) => key)
    ).toEqual(["web-1", "k"]);
    expect(
      itemsOfRow(items, "Pod", "shop", "web-1").map(({ key }) => key)
    ).toEqual(["web-1"]);
    expect(itemsOfRow(items, "Deployment", null, "web")).toEqual([]);
  });
});
