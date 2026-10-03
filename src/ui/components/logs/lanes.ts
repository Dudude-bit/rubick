import type { ContainerInfo, PodInfo } from "@/generated/types";
import { podContainers } from "@/lib/container-sequence";

import { containerColor } from "./container-colors";
import type { LogSource } from "./hooks/useLogStream";
import type { LegendContainer, LegendEntry } from "./LogLegend";

export function containerEntries(containers: LegendContainer[]): LegendEntry[] {
  return containers.map(({ name, phase, state }) => ({
    key: name,
    label: name,
    phase,
    state,
  }));
}

/** What the lane colour stands for, named in the toolbar so it always means one thing. */
export type LaneRule = "pod" | "ordinal" | "node" | "run";

export type LaneLabelMode = "colour" | "short" | "full";

/** One pod of a workload pane, with what its lane is labelled by. */
export interface LanePod {
  name: string;
  namespace: string;
  containers: ContainerInfo[];
  node: string | null;
  /** The Job that ran it, for a CronJob's lanes. */
  run: string | null;
}

export function lanePodOf(pod: PodInfo): LanePod {
  return {
    name: pod.name,
    namespace: pod.namespace,
    containers: podContainers(pod),
    node: pod.nodeName,
    run:
      pod.ownerReferences.find((owner) => owner.kind === "Job")?.name ?? null,
  };
}

export const GONE_LANE_COLOR = "hsl(var(--fg-fnt))";

/** The last characters of a generated name: what a colleague reads off a line pasted into a chat. */
export function shortLane(name: string): string {
  const dash = name.lastIndexOf("-");
  return dash === -1 ? name.slice(-5) : name.slice(dash + 1);
}

/**
 * What a lane is called under a rule; the pod's name where the rule has
 * nothing better, and where the rule's own name is not this lane's alone.
 *
 * A Job with `parallelism: 3` gives every pod the same owning Job, and a
 * retried CronJob pod does too: three chips reading `import-orders`, three
 * identical row labels, and hiding one takes away lines with nothing on
 * screen saying which. `taken` is the names the other lanes already use.
 */
export function laneName(
  pod: LanePod | null,
  key: string,
  rule: LaneRule,
  taken?: ReadonlyMap<string, number>
): string {
  if (!pod) return key;
  const named = rule === "node" ? pod.node : rule === "run" ? pod.run : null;
  if (!named) return pod.name;
  return (taken?.get(named) ?? 1) > 1
    ? `${named}/${shortLane(pod.name)}`
    : named;
}

/** How many of these lanes each rule-name covers, for {@link laneName}. */
export function laneNameCounts(
  pods: readonly LanePod[],
  rule: LaneRule
): Map<string, number> {
  const counts = new Map<string, number>();
  if (rule !== "node" && rule !== "run") return counts;
  for (const pod of pods) {
    const named = rule === "node" ? pod.node : pod.run;
    if (!named) continue;
    counts.set(named, (counts.get(named) ?? 0) + 1);
  }
  return counts;
}

export function laneLabel(
  pod: LanePod | null,
  key: string,
  rule: LaneRule,
  mode: LaneLabelMode,
  taken?: ReadonlyMap<string, number>
): string | null {
  if (mode === "colour") return null;
  const name = laneName(pod, key, rule, taken);
  return mode === "short" ? shortLane(name) : name;
}

/** Every stream a set of pods needs, app containers first within each pod. */
export function sourcesOf(pods: LanePod[]): LogSource[] {
  return pods.flatMap((pod) =>
    pod.containers.map((container) => ({
      pod: pod.name,
      namespace: pod.namespace,
      container: container.name,
      // The apiserver refuses a log for a container that has not started,
      // and nothing else about the source changes when it does. Without
      // this the refusal is permanent for the life of the pane, sitting
      // beside a pod list that has been showing it Running for ten minutes.
      started: container.state.type !== "waiting",
    }))
  );
}

/**
 * A colour per lane, from a ledger of the order the lanes were first seen,
 * and grey for a lane whose pod is gone: the lines stay, the pod does not.
 *
 * The ledger, rather than the position in the current list, because the
 * list is rebuilt from every poll: a pod dropping out of it used to shift
 * every pod after it one step along the hues, so the lines already in the
 * buffer changed colour under the reader mid-rollout and the replacement
 * inherited the hue they were following. The gutter is the only thing
 * identifying a lane in the default label mode.
 */
export function laneColors(
  keys: readonly string[],
  gone: ReadonlySet<string>,
  order: readonly string[]
): Map<string, string> {
  const colors = new Map<string, string>();
  // A lane the order has not caught up with yet still gets a colour, and
  // the same one it will keep: appended in the order it appears here.
  const unknown: string[] = [];
  const hueOf = (key: string) => {
    const known = order.indexOf(key);
    if (known !== -1) return known;
    const pending = unknown.indexOf(key);
    if (pending !== -1) return order.length + pending;
    unknown.push(key);
    return order.length + unknown.length - 1;
  };
  for (const key of keys) {
    colors.set(
      key,
      gone.has(key) ? GONE_LANE_COLOR : containerColor(hueOf(key))
    );
  }
  return colors;
}

/** The lane order with whatever is new appended; identity-stable when nothing is. */
export function laneOrderWith(
  order: readonly string[],
  keys: readonly string[]
): string[] {
  const fresh = keys.filter((key) => !order.includes(key));
  return fresh.length === 0 ? (order as string[]) : [...order, ...fresh];
}
