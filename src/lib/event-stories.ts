/**
 * Events folded into stories: one object, one window, one sentence.
 *
 * Everything here is read off the events themselves. A pod belongs to a
 * Deployment because a ReplicaSet said "Created pod: x" and the Deployment
 * said "Scaled up replica set y"; where no controller said so, pods are
 * folded by the generated suffix of their names and the story says so.
 */

import type { EventInfo } from "@/generated/types";
import type { Saying } from "@/i18n/say";

export type Activity =
  | "crash"
  | "pull"
  | "scheduling"
  | "volume"
  | "pressure"
  | "probe"
  | "job"
  | "scaling"
  | "node"
  | "rollout"
  | "other";

/** When a story has warnings of several activities, the first wins. */
const ACTIVITY_RANK: Activity[] = [
  "crash",
  "pull",
  "scheduling",
  "volume",
  "pressure",
  "probe",
  "job",
  "scaling",
  "node",
  "rollout",
  "other",
];

export interface Subject {
  /** `null` when pods were folded by name alone and no controller claimed them. */
  kind: string | null;
  name: string;
  namespace: string | null;
  /** Some member was placed here by its name's generated suffix, not by an event. */
  byName: boolean;
}

export interface ReasonCount {
  reason: string;
  warning: boolean;
  count: number;
}

/**
 * Whether the trouble is over, and the case where that is not answerable.
 *
 * `unknown` is not a fourth kind of trouble, it is the absence of an answer:
 * the events this was folded from were narrowed before they arrived, or the
 * latest warning carries no time. Either way "done" would be a claim nobody
 * made — and the loudest one, because it is the green card the reader stops
 * looking at.
 */
export type StoryState = "stillHappening" | "settled" | "done" | "unknown";

export interface Story {
  key: string;
  subject: Subject;
  activity: Activity;
  /** Oldest first. */
  events: EventInfo[];
  /** The objects the events were about, when more than one folded in. */
  members: string[];
  reasons: ReasonCount[];
  occurrences: number;
  warnings: number;
  firstAt: number | null;
  lastAt: number | null;
  state: StoryState;
  says: Saying;
}

export const STORY_WINDOWS = ["15m", "1h", "6h", "24h"] as const;
export type StoryWindow = (typeof STORY_WINDOWS)[number];
export const WINDOW_MS: Record<StoryWindow, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

/** A warning younger than this is "still happening". */
export const RECENT_MS = 5 * 60_000;

const DETAIL_LIMIT = 140;

/** The alphabet Kubernetes generates pod and template-hash suffixes from. */
const SUFFIX = "[bcdfghjklmnpqrstvwxz2456789]";
const POD_SUFFIX = new RegExp(`^(.+)-${SUFFIX}{5}$`);
const HASH_SUFFIX = new RegExp(`^(.+)-${SUFFIX}{5,10}$`);

/**
 * The name a pod would share with its siblings, or its own name when it
 * carries no generated suffix (a StatefulSet's `web-0`, a bare pod).
 */
export function familyOf(name: string): string {
  const pod = POD_SUFFIX.exec(name);
  return pod ? baseOfHash(pod[1]) : name;
}

function baseOfHash(name: string): string {
  return HASH_SUFFIX.exec(name)?.[1] ?? name;
}

const FOLDED_KINDS = new Set([
  "Pod",
  "ReplicaSet",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
]);

const CREATED_POD = /(?:Created|Deleted) pod: (\S+)/;
const STATEFUL_POD = /(?:create|delete) Pod (\S+) in StatefulSet/;
const SCALED_RS = /replica set (\S+)/;
const CREATED_JOB = /(?:Created|Deleted) job:? (\S+)/;

interface Owner {
  kind: string;
  name: string;
}

function at(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function objectKey(namespace: string | null, kind: string, name: string) {
  return `${namespace ?? ""}/${kind}/${name}`;
}

/** Who created what, as the controllers themselves wrote it. */
function evidenceOf(events: EventInfo[]): Map<string, Owner> {
  const owner = new Map<string, Owner>();
  for (const event of events) {
    const { kind, name } = event.involvedObject;
    const namespace = event.involvedObject.namespace ?? event.namespace;
    const message = event.message ?? "";
    const claim = (childKind: string, child: string | undefined) => {
      if (child)
        owner.set(objectKey(namespace, childKind, child), { kind, name });
    };
    if (kind === "Deployment" && event.reason === "ScalingReplicaSet") {
      claim("ReplicaSet", SCALED_RS.exec(message)?.[1]);
    } else if (kind === "CronJob") {
      claim("Job", CREATED_JOB.exec(message)?.[1]);
    } else if (kind === "StatefulSet") {
      claim("Pod", STATEFUL_POD.exec(message)?.[1]);
    } else if (["ReplicaSet", "DaemonSet", "Job"].includes(kind)) {
      claim("Pod", CREATED_POD.exec(message)?.[1]);
    }
  }
  return owner;
}

interface Placement {
  key: string;
  subject: Subject;
}

function place(event: EventInfo, evidence: Map<string, Owner>): Placement {
  const namespace = event.involvedObject.namespace ?? event.namespace;
  let kind = event.involvedObject.kind;
  let name = event.involvedObject.name;
  if (!FOLDED_KINDS.has(kind)) {
    return {
      key: objectKey(namespace, kind, name),
      subject: { kind, name, namespace, byName: false },
    };
  }
  for (let hop = 0; hop < 3; hop += 1) {
    const owner = evidence.get(objectKey(namespace, kind, name));
    if (!owner) break;
    kind = owner.kind;
    name = owner.name;
  }
  if (kind === "Pod" || kind === "ReplicaSet") {
    const family = kind === "Pod" ? familyOf(name) : baseOfHash(name);
    if (family !== name) {
      return {
        key: `${namespace ?? ""}/${family}`,
        subject: { kind: null, name: family, namespace, byName: true },
      };
    }
  }
  return {
    key: `${namespace ?? ""}/${name}`,
    subject: { kind, name, namespace, byName: false },
  };
}

const VOLUME_REASONS = new Set([
  "FailedMount",
  "FailedAttachVolume",
  "FailedMapVolume",
  "SuccessfulAttachVolume",
  "VolumeResizeFailed",
  "VolumeResizeSuccessful",
  "FileSystemResizeSuccessful",
  "FileSystemResizeFailed",
  "Provisioning",
  "ProvisioningSucceeded",
  "ProvisioningFailed",
  "ExternalProvisioning",
  "WaitForFirstConsumer",
  "WaitForPodScheduled",
  "FailedBinding",
]);
const PRESSURE_REASONS = new Set([
  "Evicted",
  "EvictionThresholdMet",
  "OOMKilling",
  "NodeHasInsufficientMemory",
  "NodeHasDiskPressure",
  "NodeHasMemoryPressure",
  "NodeHasPIDPressure",
  "FreeDiskSpaceFailed",
  "ImageGCFailed",
  "SystemOOM",
]);
const NODE_REASONS = new Set([
  "NodeHasNoDiskPressure",
  "NodeHasSufficientMemory",
  "NodeHasSufficientPID",
  "NodeReady",
  "NodeNotReady",
  "Rebooted",
  "Starting",
  "RegisteredNode",
  "NodeAllocatableEnforced",
  "NodeNotSchedulable",
  "NodeSchedulable",
  "RemovingNode",
  "DeletingNode",
  "CIDRAssignmentFailed",
  "InvalidDiskCapacity",
]);
const JOB_REASONS = new Set([
  "Completed",
  "SawCompletedJob",
  "BackoffLimitExceeded",
  "DeadlineExceeded",
  "TooManyMissedTimes",
  "MissingJob",
  "UnexpectedJob",
  "FailedNeedsStart",
  "SuccessfulDelete",
  "FailedDelete",
]);
const SCALING_REASONS = new Set([
  "SuccessfulRescale",
  "FailedGetResourceMetric",
  "FailedComputeMetricsReplicas",
  "FailedGetScale",
  "FailedRescale",
  "FailedGetObjectMetric",
  "FailedGetExternalMetric",
]);
const LIFECYCLE_REASONS = new Set([
  "Scheduled",
  "Pulling",
  "Pulled",
  "Created",
  "Started",
  "Killing",
  "SuccessfulCreate",
  "SuccessfulDelete",
  "FailedCreate",
  "FailedDelete",
  "ScalingReplicaSet",
  "DeploymentRollback",
]);
const PULL_REASONS = new Set([
  "ErrImagePull",
  "ErrImageNeverPull",
  "InspectFailed",
  "ImagePullBackOff",
]);
const SCHEDULING_REASONS = new Set([
  "FailedScheduling",
  "Preempted",
  "TriggeredScaleUp",
  "NotTriggerScaleUp",
]);

/** What the controller was doing, from the reason and, where it is ambiguous, the message. */
export function activityOf(
  event: EventInfo,
  subjectKind: string | null
): Activity {
  const reason = event.reason ?? "";
  const message = event.message ?? "";
  const kind = event.involvedObject.kind;
  const ofJob = subjectKind === "Job" || subjectKind === "CronJob";
  if (reason === "BackOff")
    return /pulling image/i.test(message) ? "pull" : "crash";
  if (reason === "Failed" && kind === "Pod")
    return /image/i.test(message) ? "pull" : "crash";
  if (PULL_REASONS.has(reason)) return "pull";
  if (SCHEDULING_REASONS.has(reason)) return "scheduling";
  if (reason === "Unhealthy" || reason === "ProbeWarning") return "probe";
  if (PRESSURE_REASONS.has(reason)) return "pressure";
  if (NODE_REASONS.has(reason)) return "node";
  if (VOLUME_REASONS.has(reason)) return "volume";
  if (SCALING_REASONS.has(reason)) return "scaling";
  if (
    JOB_REASONS.has(reason) &&
    (ofJob || kind === "Job" || kind === "CronJob")
  )
    return "job";
  if (LIFECYCLE_REASONS.has(reason)) return ofJob ? "job" : "rollout";
  return "other";
}

function occurrencesOf(event: EventInfo): number {
  return Math.max(1, event.count ?? 1);
}

function detailOf(event: EventInfo | undefined): string {
  const text = (event?.message ?? event?.reason ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > DETAIL_LIMIT
    ? `${text.slice(0, DETAIL_LIMIT - 1)}…`
    : text;
}

function reasonsOf(events: EventInfo[]): ReasonCount[] {
  const counts = new Map<string, ReasonCount>();
  for (const event of events) {
    const reason = event.reason ?? "?";
    const warning = event.type === "Warning";
    const key = `${warning ? "W" : "N"}:${reason}`;
    const entry = counts.get(key) ?? { reason, warning, count: 0 };
    entry.count += occurrencesOf(event);
    counts.set(key, entry);
  }
  return [...counts.values()].sort(
    (a, b) =>
      Number(b.warning) - Number(a.warning) ||
      b.count - a.count ||
      a.reason.localeCompare(b.reason)
  );
}

/** The most frequent activity by occurrences; ties go to the ranked order. */
function normalActivity(
  events: EventInfo[],
  subjectKind: string | null
): Activity {
  const counts = new Map<Activity, number>();
  for (const event of events) {
    const activity = activityOf(event, subjectKind);
    counts.set(activity, (counts.get(activity) ?? 0) + occurrencesOf(event));
  }
  let best: Activity = "other";
  let bestCount = -1;
  for (const activity of ACTIVITY_RANK) {
    const count = counts.get(activity) ?? 0;
    if (count > bestCount) {
      best = activity;
      bestCount = count;
    }
  }
  return best;
}

/** A bare "Error: ErrImagePull" says less than the message beside it. */
const BARE_ERROR = /^Error: \S+$/;

function informative(warnings: EventInfo[]): EventInfo | undefined {
  const telling = warnings.filter((e) => !BARE_ERROR.test(e.message ?? ""));
  return (telling.length > 0 ? telling : warnings).at(-1);
}

function countReason(events: EventInfo[], ...reasons: string[]): number {
  return events
    .filter((e) => reasons.includes(e.reason ?? ""))
    .reduce((sum, e) => sum + occurrencesOf(e), 0);
}

function topReasons(reasons: ReasonCount[]): string {
  return reasons
    .slice(0, 3)
    .map((r) => `${r.reason} ×${r.count}`)
    .join(", ");
}

function sentenceOf(
  activity: Activity,
  events: EventInfo[],
  warnings: EventInfo[],
  reasons: ReasonCount[],
  spanMs: number
): Saying {
  if (warnings.length === 0) {
    switch (activity) {
      case "rollout":
        return {
          key: "storyRollout",
          values: {
            spanMs,
            scheduled: countReason(events, "Scheduled"),
            pulled: countReason(events, "Pulled"),
            started: countReason(events, "Started"),
            stopped: countReason(events, "Killing"),
          },
        };
      case "job":
        return {
          key: "storyJob",
          values: {
            spanMs,
            created: {
              key: "jobsCreated" as const,
              values: { n: countReason(events, "SuccessfulCreate") },
            },
            completed: countReason(events, "Completed", "SawCompletedJob"),
          },
        };
      default:
        return {
          key: "storyQuiet",
          values: { spanMs, reasons: topReasons(reasons) },
        };
    }
  }
  const n = warnings.reduce((sum, e) => sum + occurrencesOf(e), 0);
  const detail = detailOf(informative(warnings));
  // The count is its own sentence, because no language can hand another a
  // substring of its own plural: Russian needs three forms where English
  // needs two, and `{n} times` in the outer string gets neither.
  const troubled = {
    times: { key: "timesSeen" as const, values: { n } },
    spanMs,
    detail,
  };
  switch (activity) {
    case "crash":
      return { key: "storyCrash", values: troubled };
    case "pull":
      return { key: "storyPull", values: troubled };
    case "scheduling": {
      const answers = new Set(warnings.map((e) => e.message ?? ""));
      return answers.size === 1
        ? { key: "storySchedulingSame", values: troubled }
        : {
            key: "storySchedulingVaried",
            values: { ...troubled, k: answers.size },
          };
    }
    case "probe":
      return { key: "storyProbe", values: troubled };
    case "pressure":
      return { key: "storyPressure", values: troubled };
    case "volume":
      return { key: "storyVolumeTrouble", values: troubled };
    case "job":
      return { key: "storyJobTrouble", values: troubled };
    case "scaling":
      return { key: "storyScaling", values: troubled };
    case "node":
      return { key: "storyNode", values: troubled };
    case "rollout":
      return { key: "storyRolloutTrouble", values: troubled };
    case "other":
      return {
        key: "storyTrouble",
        values: { ...troubled, reason: warnings.at(-1)?.reason ?? "?" },
      };
  }
}

export interface StoryOptions {
  now: number;
  windowMs: number;
  /**
   * Whether these events are everything the window holds, or what survived a
   * filter. A fold over a narrowed feed cannot say a story is over: the
   * warnings that would say otherwise may simply not have been passed in.
   */
  narrowed: boolean;
}

/** The events in the window, folded into stories. Order is not meaningful; see {@link sortStories}. */
export function storiesOf(events: EventInfo[], options: StoryOptions): Story[] {
  const { now, windowMs } = options;
  const since = now - windowMs;
  const inWindow = events.filter((event) => {
    const last = at(event.lastTimestamp);
    return last === null || last >= since;
  });
  const evidence = evidenceOf(inWindow);
  const groups = new Map<string, { subject: Subject; events: EventInfo[] }>();
  for (const event of inWindow) {
    const { key, subject } = place(event, evidence);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { subject, events: [event] });
      continue;
    }
    group.events.push(event);
    if (group.subject.kind === null && subject.kind !== null) {
      group.subject = { ...subject, byName: true };
    } else if (subject.byName) {
      group.subject = { ...group.subject, byName: true };
    }
  }

  const stories: Story[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group.events].sort(
      (a, b) =>
        (at(a.lastTimestamp) ?? Infinity) - (at(b.lastTimestamp) ?? Infinity) ||
        a.uid.localeCompare(b.uid)
    );
    const dated = sorted.flatMap((e) => {
      const first = at(e.firstTimestamp) ?? at(e.lastTimestamp);
      const last = at(e.lastTimestamp);
      return [first, last].filter((v): v is number => v !== null);
    });
    const firstAt = dated.length > 0 ? Math.min(...dated) : null;
    const lastAt = dated.length > 0 ? Math.max(...dated) : null;
    const reasons = reasonsOf(sorted);
    const warnings = reasons
      .filter((r) => r.warning)
      .reduce((sum, r) => sum + r.count, 0);
    const occurrences = reasons.reduce((sum, r) => sum + r.count, 0);
    const warningEvents = sorted.filter((e) => e.type === "Warning");
    const latestWarning = warningEvents.at(-1);
    // The story is about what went wrong last; the rest stays in the chips.
    const activity = latestWarning
      ? activityOf(latestWarning, group.subject.kind)
      : normalActivity(sorted, group.subject.kind);
    const ofActivity = warningEvents.filter(
      (e) => activityOf(e, group.subject.kind) === activity
    );
    // `null`, not `now`: an event the cluster gave no time to is one this
    // cannot place, and reading it as "this instant" makes the quietest
    // answer the loudest. The window filter above keeps such an event for
    // exactly that reason — because the time is unknown.
    const latestWarningAt = latestWarning
      ? at(latestWarning.lastTimestamp)
      : null;
    const state: StoryState =
      warnings === 0
        ? // Nothing went wrong *in what was read*. Where a filter narrowed
          // that, the difference between "nothing went wrong" and "the
          // warnings were not in the set" is the whole answer.
          options.narrowed
          ? "unknown"
          : "done"
        : latestWarningAt === null
          ? "unknown"
          : latestWarningAt >= now - RECENT_MS
            ? "stillHappening"
            : "settled";
    const members = [
      ...new Set(
        sorted.map((e) => `${e.involvedObject.kind}/${e.involvedObject.name}`)
      ),
    ];
    stories.push({
      key,
      subject: group.subject,
      activity,
      events: sorted,
      members,
      reasons,
      occurrences,
      warnings,
      firstAt,
      lastAt,
      state,
      says: sentenceOf(
        activity,
        sorted,
        ofActivity,
        reasons,
        firstAt !== null && lastAt !== null ? lastAt - firstAt : 0
      ),
    });
  }
  return stories;
}

export type StoryOrder = "warningsFirst" | "newest";

// Above `done`: a story nobody could place may be the one still burning, and
// the list is read from the top.
const STATE_RANK: Record<StoryState, number> = {
  stillHappening: 0,
  settled: 1,
  unknown: 2,
  done: 3,
};

export function sortStories(stories: Story[], order: StoryOrder): Story[] {
  return [...stories].sort((a, b) => {
    if (order === "warningsFirst") {
      const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
      if (byState !== 0) return byState;
      if (a.warnings !== b.warnings) return b.warnings - a.warnings;
    }
    return (
      (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity) ||
      a.key.localeCompare(b.key)
    );
  });
}

export interface DensityBucket {
  count: number;
  worst: "warn" | null;
}

/** When each event was last seen, over the window, in `buckets` equal slices. */
export function densityOf(
  story: Story,
  { now, windowMs }: StoryOptions,
  buckets = 24
): DensityBucket[] {
  const out: DensityBucket[] = Array.from({ length: buckets }, () => ({
    count: 0,
    worst: null,
  }));
  const since = now - windowMs;
  for (const event of story.events) {
    const last = at(event.lastTimestamp);
    if (last === null) continue;
    const index = Math.min(
      buckets - 1,
      Math.max(0, Math.floor(((last - since) / windowMs) * buckets))
    );
    out[index].count += 1;
    if (event.type === "Warning") out[index].worst = "warn";
  }
  return out;
}

export interface TimelineEntry {
  at: number | null;
  until: number | null;
  warning: boolean;
  reason: string;
  message: string;
  count: number;
  /** The object this event was about; shown when the story folds several. */
  about: { kind: string; name: string };
  /** A pod's own status placed on the same clock. */
  fromStatus: boolean;
}

export function timelineOf(story: Story): TimelineEntry[] {
  return story.events
    .map((event) => {
      const first = at(event.firstTimestamp) ?? at(event.lastTimestamp);
      const last = at(event.lastTimestamp);
      return {
        at: first,
        until: last !== null && first !== null && last > first ? last : null,
        warning: event.type === "Warning",
        reason: event.reason ?? "?",
        message: (event.message ?? "").replace(/\s+/g, " ").trim(),
        count: occurrencesOf(event),
        about: {
          kind: event.involvedObject.kind,
          name: event.involvedObject.name,
        },
        fromStatus: false,
      };
    })
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

export interface StatusMark {
  at: number;
  container: string;
  exitCode: number;
  reason: string | null;
  pod: string;
}

/** The exits a pod's status remembers, folded into the timeline at their own times. */
export function withStatusMarks(
  entries: TimelineEntry[],
  marks: StatusMark[]
): TimelineEntry[] {
  const extra: TimelineEntry[] = marks.map((mark) => ({
    at: mark.at,
    until: null,
    warning: mark.exitCode !== 0,
    reason: mark.reason ?? `exit ${mark.exitCode}`,
    message: "",
    count: 1,
    about: { kind: "Pod", name: mark.pod },
    fromStatus: true,
  }));
  return [...entries, ...extra].sort(
    (a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)
  );
}
