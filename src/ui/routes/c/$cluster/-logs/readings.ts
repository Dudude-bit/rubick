import type { ContainerInfo } from "@/generated/types";
import type { en } from "@/i18n/catalogue";

import type { ContainerFailure } from "./hooks/useLogStream";

/**
 * What one stream, or the pod made of several, is doing for the reader.
 * The header's counts and the legend's chips both read it from here, so one
 * pod cannot be streaming in one and unreadable in the other.
 */
export type StreamReading =
  | "streaming"
  | "read"
  | "ended"
  | "restarting"
  | "notFollowed"
  | "notStarted"
  | "lost"
  | "notKept"
  | "absent";

const WORST_FIRST: readonly StreamReading[] = [
  "lost",
  "notKept",
  "notFollowed",
  "restarting",
  "notStarted",
  "streaming",
  "ended",
  "read",
  "absent",
];

export const CHIP_WORD: Record<StreamReading, keyof typeof en.empty | null> = {
  streaming: null,
  read: null,
  ended: "chipEnded",
  restarting: "chipRestarting",
  notFollowed: "chipNotFollowed",
  notStarted: "chipNotStarted",
  lost: "chipLost",
  notKept: "chipLogNotKept",
  absent: "chipNoEarlierRun",
};

/** A waiting container that has run is in back-off, and its last run's log reads like any other. */
export function hasStarted(container: ContainerInfo): boolean {
  return (
    container.state.type !== "waiting" || container.lastTerminated !== null
  );
}

export interface HowRead {
  previous: boolean;
  /** The workload's pods are restarted whatever the exit: a Deployment's, not a Job's. */
  restartsAlways: boolean;
}

function comesBack(
  container: ContainerInfo | undefined,
  restartsAlways: boolean
): boolean {
  if (!container) return false;
  switch (container.state.type) {
    case "waiting":
      return hasStarted(container);
    case "running":
      return restartsAlways || container.restartCount > 0;
    case "terminated":
      return (
        container.phase === "app" &&
        (restartsAlways ||
          (container.restartCount > 0 &&
            container.state.termination.exitCode !== 0))
      );
    case "unknown":
      return false;
  }
}

export function readingOf(
  failure: Pick<ContainerFailure, "kind"> | undefined,
  container: ContainerInfo | undefined,
  { previous, restartsAlways }: HowRead
): StreamReading {
  if (!failure) return previous ? "read" : "streaming";
  switch (failure.kind) {
    case "gone":
      return comesBack(container, restartsAlways) ? "restarting" : "ended";
    case "broken":
      return container && !hasStarted(container) ? "notStarted" : "lost";
    case "no-previous-run":
      return "absent";
    case "log-not-kept":
      return "notKept";
    case "follow-stopped":
      return "notFollowed";
  }
}

export function worstReading(
  readings: readonly StreamReading[]
): StreamReading | null {
  return WORST_FIRST.find((reading) => readings.includes(reading)) ?? null;
}

export interface ReadSource {
  lane: string;
  pod: string;
  container: string;
  info: ContainerInfo | undefined;
}

export interface LaneReading {
  reading: StreamReading;
  note: string | null;
}

export function readLanes(
  sources: readonly ReadSource[],
  failures: readonly Pick<
    ContainerFailure,
    "pod" | "container" | "kind" | "message"
  >[],
  how: HowRead
): Map<string, LaneReading> {
  const each = new Map<string, LaneReading[]>();
  for (const { lane, pod, container, info } of sources) {
    const failure = failures.find(
      (entry) => entry.pod === pod && entry.container === container
    );
    each.set(lane, [
      ...(each.get(lane) ?? []),
      {
        reading: readingOf(failure, info, how),
        note: failure?.message ?? null,
      },
    ]);
  }
  const lanes = new Map<string, LaneReading>();
  for (const [lane, readings] of each) {
    const worst = worstReading(readings.map(({ reading }) => reading));
    const found = readings.find(({ reading }) => reading === worst);
    if (found) lanes.set(lane, found);
  }
  return lanes;
}

export function countReadings(
  readings: Iterable<StreamReading | undefined>
): Record<StreamReading, number> {
  const counts = Object.fromEntries(
    WORST_FIRST.map((reading) => [reading, 0])
  ) as Record<StreamReading, number>;
  for (const reading of readings) if (reading) counts[reading] += 1;
  return counts;
}
