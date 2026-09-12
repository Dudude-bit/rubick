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

/** What a lane is called under a rule; the pod's name where the rule has nothing better. */
export function laneName(
  pod: LanePod | null,
  key: string,
  rule: LaneRule
): string {
  if (!pod) return key;
  if (rule === "node" && pod.node) return pod.node;
  if (rule === "run" && pod.run) return pod.run;
  return pod.name;
}

export function laneLabel(
  pod: LanePod | null,
  key: string,
  rule: LaneRule,
  mode: LaneLabelMode
): string | null {
  if (mode === "colour") return null;
  const name = laneName(pod, key, rule);
  return mode === "short" ? shortLane(name) : name;
}

/** Every stream a set of pods needs, app containers first within each pod. */
export function sourcesOf(pods: LanePod[]): LogSource[] {
  return pods.flatMap((pod) =>
    pod.containers.map((container) => ({
      pod: pod.name,
      namespace: pod.namespace,
      container: container.name,
    }))
  );
}

/**
 * A colour per lane, in the order the lanes were first seen, and grey for
 * a lane whose pod is gone: the lines stay, the pod does not.
 */
export function laneColors(
  keys: readonly string[],
  gone: ReadonlySet<string>
): Map<string, string> {
  const colors = new Map<string, string>();
  let index = 0;
  for (const key of keys) {
    if (gone.has(key)) {
      colors.set(key, GONE_LANE_COLOR);
      continue;
    }
    colors.set(key, containerColor(index));
    index += 1;
  }
  return colors;
}
