/**
 * Several namespaces' overviews, added up into one.
 *
 * The backend answers this question for one scope at a time, so a window
 * looking at three namespaces asks three times and joins the answers here.
 * The join is not a general merge and must not become one: every field is
 * either *namespace-scoped* and summed, or *cluster-scoped* and taken once.
 *
 * Getting that wrong is not a cosmetic bug. `nodes` is the whole cluster's
 * node list in every one of the three answers — summing it would report a
 * three-node cluster as having nine — and `counts.namespaces` is how many
 * namespaces exist, not how many are being looked at.
 *
 * Two fields are neither summed nor taken once, because they are *lists the
 * backend had already ordered and cut*: joining them end to end keeps each
 * part's ordering and throws away the whole's. Both are rebuilt here by the
 * same rule `src-tauri/src/commands/overview.rs` uses, and that file is where
 * the rule is decided — this one follows it.
 */

import type {
  ClusterOverview,
  ClusterProblem,
  ResourceCounts,
  WarningGroup,
} from "@/generated/types";

/** Namespace-scoped counts: real per-scope numbers, so they add up. */
const SUMMED: ReadonlyArray<keyof ResourceCounts> = [
  "pods",
  "deployments",
  "statefulSets",
  "daemonSets",
  "jobs",
  "cronJobs",
  "services",
  "ingresses",
  "configMaps",
  "secrets",
  "events",
];

/**
 * `MAX_PROBLEMS` in `src-tauri/src/commands/overview.rs`, mirrored.
 *
 * Every part arrives ranked and already cut to it, so the join has to be cut
 * to the same number: a panel that grew by fifty rows per namespace watched
 * would defeat the cap on exactly the cluster the cap was written for.
 */
const MAX_PROBLEMS = 50;

/**
 * A count is `null` where the cluster refused to say, and that has to survive
 * the sum: two namespaces answered and a third refused is not a total, and
 * printing one would state a number the reader cannot check.
 */
function addCounts(parts: ResourceCounts[], whole: ResourceCounts) {
  const counts: ResourceCounts = { ...whole };
  for (const field of SUMMED) {
    counts[field] = parts.some((part) => part[field] == null)
      ? null
      : parts.reduce((sum, part) => sum + (part[field] ?? 0), 0);
  }
  return counts;
}

/**
 * Worst first, then oldest first — `rank_and_cap` in the backend.
 *
 * Concatenation leaves the rows in per-namespace order, so a panel captioned
 * "worst first" would list twenty mild problems from the first namespace
 * above a CrashLoopBackOff from the second.
 *
 * `since` is RFC3339 written by the same backend, so string order is time
 * order, and an undated problem sorts first exactly as it does there: an
 * unknown age is not evidence that a problem is young.
 */
function rank(problems: ClusterProblem[]): ClusterProblem[] {
  return [...problems].sort((a, b) => {
    const severity =
      Number(a.severity === "warning") - Number(b.severity === "warning");
    if (severity !== 0) return severity;
    const since = a.since ?? "";
    const other = b.since ?? "";
    return since < other ? -1 : since > other ? 1 : 0;
  });
}

/**
 * One row per reason, however many namespaces reported it.
 *
 * `WarningsPanel` keys its rows by `reason`, so two namespaces both reporting
 * `FailedScheduling` rendered two rows under one React key — one of which the
 * reader never saw, showing one namespace's count where the total belonged.
 *
 * `count` is the only field of a group that adds up. The rest describe a
 * single event: the newest occurrence of that reason, which is what they
 * already mean inside one namespace, where the count also spans objects the
 * sample says nothing about. They move as a set — a message from one
 * namespace under a timestamp from another would describe an event that never
 * happened — and dropping them instead would take away the one sentence that
 * says what went wrong to prevent a claim the row does not make.
 */
function addWarnings(parts: ClusterOverview[]): WarningGroup[] {
  const byReason = new Map<string, WarningGroup>();
  for (const group of parts.flatMap((part) => part.warnings)) {
    const merged = byReason.get(group.reason);
    if (!merged) {
      byReason.set(group.reason, { ...group });
      continue;
    }
    merged.count += group.count;
    // A group with no timestamp cannot be shown to be the newer one, so it
    // never takes the sample over from one that has a time.
    if (
      group.lastSeen !== null &&
      (merged.lastSeen === null || group.lastSeen > merged.lastSeen)
    ) {
      merged.lastSeen = group.lastSeen;
      merged.sample = group.sample;
      merged.objectKind = group.objectKind;
      merged.objectName = group.objectName;
      merged.namespace = group.namespace;
    }
  }
  // Loudest first, as each part arrived — an order the sums have just changed.
  return [...byReason.values()].sort(
    (a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)
  );
}

/**
 * One row per problem, not one per namespace that reported it.
 *
 * `problems` looks namespace-scoped and is not: the backend builds it as pod
 * problems plus deployment problems plus **node** problems, and the node half
 * comes off the cluster API whatever namespace was asked for
 * (`overview.rs:893-896`, `:936`). So every part in the fan-out carries the
 * same node rows, and concatenating them drew a single NotReady node four
 * times over a four-namespace scope — with four identical React keys, and a
 * headline that counted it four times.
 *
 * Keyed exactly as `ProblemsPanel` keys its rows, so two rows that collapse
 * here are two rows that would have collided there.
 */
function dedupe(problems: ClusterProblem[]): ClusterProblem[] {
  const seen = new Map<string, ClusterProblem>();
  for (const problem of problems) {
    const key = `${problem.kind}/${problem.namespace ?? "-"}/${problem.name}/${problem.reason}`;
    if (!seen.has(key)) seen.set(key, problem);
  }
  return [...seen.values()];
}

export function mergeOverviews(parts: ClusterOverview[]): ClusterOverview {
  // Cluster-scoped fields come from the first answer rather than being
  // reconciled: they are the same fact repeated, and picking one is what
  // says so.
  const [first] = parts;
  const problems = rank(dedupe(parts.flatMap((part) => part.problems)));

  return {
    ...first,
    problems: problems.slice(0, MAX_PROBLEMS),
    // Every part cut its own lowest-ranked tail, so the rows it dropped rank
    // below every row it kept and below this cut: what survives here is still
    // the worst of the whole scope, and the two numbers still add up to
    // everything the scope has wrong with it, which is what the headline
    // above the panel counts.
    problemsTruncated:
      parts.reduce((sum, part) => sum + part.problemsTruncated, 0) +
      Math.max(0, problems.length - MAX_PROBLEMS),
    warnings: addWarnings(parts),
    // `namespaces` is not joined, and there is nothing to join: it is the
    // namespace picker's breakdown of the whole cluster, and `build_overview`
    // returns an empty one for any scoped read (`overview.rs`) — one row
    // restating the selection under a heading that counts the cluster's
    // namespaces was worth less than the request. Every part of a fan-out is
    // a scoped read, so the empty vec comes through with `first`, and the
    // picker goes on reading the cluster-wide overview it always did.
    counts: addCounts(
      parts.map((part) => part.counts),
      first.counts
    ),
    pods: {
      running: parts.reduce((sum, part) => sum + part.pods.running, 0),
      pending: parts.reduce((sum, part) => sum + part.pods.pending, 0),
      succeeded: parts.reduce((sum, part) => sum + part.pods.succeeded, 0),
      failed: parts.reduce((sum, part) => sum + part.pods.failed, 0),
      unknown: parts.reduce((sum, part) => sum + part.pods.unknown, 0),
      crashLooping: parts.reduce(
        (sum, part) => sum + part.pods.crashLooping,
        0
      ),
    },
    // The rule `addCounts` follows, for the same reason: a total missing a
    // namespace that refused to answer is not a total. A token that can list
    // Jobs in one namespace and not another gets `null` here rather than a
    // number that quietly omits the rest.
    jobs: parts.some((part) => part.jobs === null)
      ? null
      : {
          completed: parts.reduce(
            (sum, part) => sum + (part.jobs?.completed ?? 0),
            0
          ),
          active: parts.reduce(
            (sum, part) => sum + (part.jobs?.active ?? 0),
            0
          ),
          failed: parts.reduce(
            (sum, part) => sum + (part.jobs?.failed ?? 0),
            0
          ),
        },
    // One namespace failing to report metrics is the whole reading failing:
    // a chart drawn from two of three namespaces is a chart with no axis.
    metricsAvailable: parts.every((part) => part.metricsAvailable),
  };
}
