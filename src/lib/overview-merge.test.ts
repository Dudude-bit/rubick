import { describe, expect, it } from "vitest";

import { mergeOverviews } from "./overview-merge";
import type {
  ClusterOverview,
  ClusterProblem,
  NodeSummary,
  ProblemSeverity,
  ResourceCounts,
  WarningGroup,
} from "@/generated/types";

const counts = (over: Partial<ResourceCounts> = {}): ResourceCounts => ({
  pods: 0,
  deployments: 0,
  statefulSets: 0,
  daemonSets: 0,
  jobs: 0,
  cronJobs: 0,
  nodes: 3,
  namespaces: 12,
  services: 0,
  ingresses: 0,
  configMaps: 0,
  secrets: 0,
  events: 0,
  ...over,
});

const node = (name: string) => ({ name }) as NodeSummary;

const problem = (
  name: string,
  namespace: string,
  over: Partial<ClusterProblem> = {}
): ClusterProblem => ({
  severity: "critical",
  kind: "Pod",
  name,
  namespace,
  reason: "CrashLoopBackOff",
  detail: null,
  since: null,
  restarts: null,
  ...over,
});

const warning = (over: Partial<WarningGroup> = {}): WarningGroup => ({
  reason: "FailedScheduling",
  count: 1,
  lastSeen: null,
  sample: null,
  objectKind: null,
  objectName: null,
  namespace: null,
  ...over,
});

/** Enough problems of one severity to reach past the backend's own cap. */
const many = (count: number, severity: ProblemSeverity, namespace: string) =>
  Array.from({ length: count }, (_, i) =>
    problem(`${namespace}-${i}`, namespace, {
      severity,
      since: `2026-08-05T00:${String(i).padStart(2, "0")}:00Z`,
    })
  );

function overview(over: Partial<ClusterOverview> = {}): ClusterOverview {
  return {
    problems: [],
    problemsTruncated: 0,
    scheduler: {} as ClusterOverview["scheduler"],
    nodes: [node("a"), node("b"), node("c")],
    warnings: [],
    namespaces: [],
    counts: counts(),
    pods: {
      running: 0,
      pending: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      crashLooping: 0,
    },
    jobs: null,
    metricsAvailable: true,
    ...over,
  };
}

describe("adding namespaces up", () => {
  /**
   * Would put a single NotReady node on screen once per selected namespace,
   * with four identical React keys and a headline counting it four times.
   * `problems` reads namespace-scoped and is not — the node half of it comes
   * off the cluster API whatever namespace was asked for.
   */
  it("draws a cluster-scoped problem once, not once per namespace", () => {
    const node: ClusterProblem = {
      severity: "critical",
      kind: "Node",
      name: "node-1",
      namespace: null,
      reason: "NotReady",
      detail: null,
      since: null,
      restarts: null,
    };
    const merged = mergeOverviews([
      overview({ problems: [node, problem("api", "prod")] }),
      overview({ problems: [node, problem("web", "staging")] }),
    ]);

    expect(merged.problems.filter((p) => p.kind === "Node")).toHaveLength(1);
    expect(merged.problems).toHaveLength(3);
    expect(merged.problems.length + merged.problemsTruncated).toBe(3);
  });

  /**
   * The rule the counts already follow. A token that can list Jobs in one
   * namespace and not another must not get a total that silently omits the
   * rest — `counts.jobs` goes null in that case and this has to agree.
   */
  it("refuses a jobs total when one scope would not say", () => {
    const merged = mergeOverviews([
      overview({ jobs: { completed: 2, active: 1, failed: 0 } }),
      overview({ jobs: null }),
    ]);
    expect(merged.jobs).toBeNull();
  });

  /**
   * Would break the moment somebody watched two namespaces: `nodes` is the
   * whole cluster's node list in *every* answer, so summing it would report a
   * three-node cluster as having six.
   */
  it("takes cluster-scoped facts once instead of summing them", () => {
    const merged = mergeOverviews([overview(), overview()]);
    expect(merged.nodes).toHaveLength(3);
    expect(merged.counts.nodes).toBe(3);
    expect(merged.counts.namespaces).toBe(12);
  });

  it("sums the counts that are per-scope", () => {
    const merged = mergeOverviews([
      overview({ counts: counts({ pods: 4, services: 1 }) }),
      overview({ counts: counts({ pods: 7, services: 2 }) }),
    ]);
    expect(merged.counts.pods).toBe(11);
    expect(merged.counts.services).toBe(3);
  });

  /**
   * Would break the app's one rule about numbers. Two namespaces answering
   * and a third refusing is not a total, and `null` is what every surface
   * already draws as nothing at all.
   */
  it("refuses a total when one scope would not say", () => {
    const merged = mergeOverviews([
      overview({ counts: counts({ pods: 4 }) }),
      overview({ counts: counts({ pods: null }) }),
    ]);
    expect(merged.counts.pods).toBeNull();
  });

  it("joins the problems every namespace reported", () => {
    const merged = mergeOverviews([
      overview({ problems: [problem("api-1", "prod")] }),
      overview({ problems: [problem("web-2", "staging")] }),
    ]);
    expect(merged.problems.map((p) => p.name)).toEqual(["api-1", "web-2"]);
  });

  /**
   * Would put back a map that was always empty and read like a decision. The
   * namespace breakdown is the picker's view of the whole cluster and the
   * backend returns none of it for a scoped read, which every part of a
   * fan-out is — so this is what the parts actually carry, and anything the
   * join built out of it would be built out of nothing.
   */
  it("does not invent a namespace breakdown a scoped read never carries", () => {
    expect(mergeOverviews([overview(), overview()]).namespaces).toEqual([]);
  });

  it("sums pod composition and the jobs every scope answered for", () => {
    const merged = mergeOverviews([
      overview({
        pods: {
          running: 3,
          pending: 1,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          crashLooping: 1,
        },
        jobs: { completed: 0, active: 0, failed: 0 },
      }),
      overview({
        pods: {
          running: 2,
          pending: 0,
          succeeded: 5,
          failed: 1,
          unknown: 0,
          crashLooping: 0,
        },
        jobs: { completed: 2, active: 1, failed: 0 },
      }),
    ]);
    expect(merged.pods.running).toBe(5);
    expect(merged.pods.crashLooping).toBe(1);
    expect(merged.jobs).toEqual({ completed: 2, active: 1, failed: 0 });
  });

  /**
   * Would break a chart's axis. Metrics missing from one of three namespaces
   * makes the whole reading partial, and a chart drawn from two thirds of a
   * scope is worse than one that says it cannot be drawn.
   */
  it("calls metrics available only when every scope has them", () => {
    expect(
      mergeOverviews([
        overview({ metricsAvailable: true }),
        overview({ metricsAvailable: false }),
      ]).metricsAvailable
    ).toBe(false);
  });
});

describe("warning events several namespaces share", () => {
  /**
   * Would break the warnings panel outright: it keys its rows by `reason`, so
   * two namespaces both reporting `FailedScheduling` rendered two rows under
   * one React key — one of them never drawn, and the count on the survivor
   * was one namespace's rather than the scope's.
   */
  it("is one row per reason, carrying the whole scope's count", () => {
    const merged = mergeOverviews([
      overview({
        warnings: [warning({ count: 4, lastSeen: "2026-08-05T10:00:00Z" })],
      }),
      overview({
        warnings: [warning({ count: 9, lastSeen: "2026-08-05T09:00:00Z" })],
      }),
    ]);
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0].count).toBe(13);
  });

  /**
   * The sample describes one event, so it has to keep describing one event.
   * Taking the message from the loudest namespace and the timestamp from the
   * most recent one would put a sentence on screen under a time it never
   * happened at.
   */
  it("takes the whole sample from whichever namespace saw it last", () => {
    const merged = mergeOverviews([
      overview({
        warnings: [
          warning({
            count: 20,
            lastSeen: "2026-08-05T09:00:00Z",
            sample: "0/3 nodes are available",
            objectKind: "Pod",
            objectName: "batch-7",
            namespace: "staging",
          }),
        ],
      }),
      overview({
        warnings: [
          warning({
            count: 1,
            lastSeen: "2026-08-05T11:00:00Z",
            sample: "Insufficient memory",
            objectKind: "Pod",
            objectName: "api-1",
            namespace: "prod",
          }),
        ],
      }),
    ]);
    expect(merged.warnings[0]).toMatchObject({
      count: 21,
      lastSeen: "2026-08-05T11:00:00Z",
      sample: "Insufficient memory",
      objectName: "api-1",
      namespace: "prod",
    });
  });

  /** An undated group cannot be shown to be the newer one. */
  it("never lets a group with no timestamp take the sample", () => {
    const merged = mergeOverviews([
      overview({
        warnings: [
          warning({ lastSeen: "2026-08-05T09:00:00Z", sample: "dated" }),
        ],
      }),
      overview({ warnings: [warning({ lastSeen: null, sample: "undated" })] }),
    ]);
    expect(merged.warnings[0].sample).toBe("dated");
  });

  /** The panel is read top-down, and the sums have just changed the order. */
  it("re-sorts by the summed count, loudest first", () => {
    const merged = mergeOverviews([
      overview({
        warnings: [
          warning({ reason: "BackOff", count: 9 }),
          warning({ reason: "FailedScheduling", count: 2 }),
        ],
      }),
      overview({
        warnings: [warning({ reason: "FailedScheduling", count: 8 })],
      }),
    ]);
    expect(merged.warnings.map((w) => w.reason)).toEqual([
      "FailedScheduling",
      "BackOff",
    ]);
  });
});

describe("ranking the joined problems", () => {
  /**
   * Would break the one promise the panel's caption makes. Concatenation
   * leaves the rows in per-namespace order, so twenty mild problems from a
   * busy namespace sat above the CrashLoopBackOff in the quiet one.
   */
  it("puts the worst row first however late its namespace answered", () => {
    const merged = mergeOverviews([
      overview({
        problems: [
          problem("web-1", "prod", {
            severity: "warning",
            reason: "Restarting",
            since: "2026-08-05T08:00:00Z",
          }),
        ],
      }),
      overview({
        problems: [
          problem("api-1", "staging", { since: "2026-08-05T10:00:00Z" }),
        ],
      }),
    ]);
    expect(merged.problems.map((p) => p.name)).toEqual(["api-1", "web-1"]);
  });

  /** Oldest first inside a severity: the top row is what has been broken longest. */
  it("orders equal severities by age, undated first", () => {
    const merged = mergeOverviews([
      overview({
        problems: [
          problem("recent", "prod", { since: "2026-08-05T10:00:00Z" }),
          problem("undated", "prod", { since: null }),
        ],
      }),
      overview({
        problems: [
          problem("old", "staging", { since: "2026-08-05T01:00:00Z" }),
        ],
      }),
    ]);
    expect(merged.problems.map((p) => p.name)).toEqual([
      "undated",
      "old",
      "recent",
    ]);
  });

  /**
   * Would grow the panel by fifty rows per namespace watched, on exactly the
   * clusters the backend's cap was written for. The dropped rows still have
   * to be counted, or the headline above the panel understates an outage.
   */
  it("cuts the join to one panel's worth and says how many it dropped", () => {
    const merged = mergeOverviews([
      overview({
        problems: many(50, "critical", "prod"),
        problemsTruncated: 3,
      }),
      overview({ problems: many(50, "warning", "staging") }),
    ]);
    expect(merged.problems).toHaveLength(50);
    // The parts each kept their own worst rows, so the survivors are the
    // scope's worst — every critical, and no warning.
    expect(merged.problems.every((p) => p.severity === "critical")).toBe(true);
    // 3 the backend dropped, plus the 50 warnings this cut dropped: the
    // headline still adds up to the 103 things that are wrong.
    expect(merged.problemsTruncated).toBe(53);
    expect(merged.problems.length + merged.problemsTruncated).toBe(103);
  });
});
