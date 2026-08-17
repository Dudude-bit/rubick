/**
 * What the status-bar trigger calls itself.
 *
 * It said "N active", which names a category nobody is looking for. A reader
 * with a port-forward running is looking for the words "port forward", and a
 * count with no noun on a line of `dark · 239 pods · 8 problems` reads as more
 * status rather than the door to the thing.
 *
 * So when only one kind of activity is running — which is the common case —
 * the trigger says which. Only a genuine mixture falls back to the total,
 * because listing three things does not fit an eleven-pixel line.
 */

export interface ActivityCounts {
  ports: number;
  terminals: number;
  jobs: number;
}

const NOUNS: Record<keyof ActivityCounts, [one: string, many: string]> = {
  ports: ["port forward", "port forwards"],
  terminals: ["terminal", "terminals"],
  jobs: ["job", "jobs"],
};

export function activityLabel(counts: ActivityCounts): string {
  const running = (Object.keys(NOUNS) as Array<keyof ActivityCounts>).filter(
    (kind) => counts[kind] > 0
  );

  if (running.length === 0) return "activity";

  if (running.length === 1) {
    const kind = running[0];
    const n = counts[kind];
    const [one, many] = NOUNS[kind];
    return `${n} ${n === 1 ? one : many}`;
  }

  return `${counts.ports + counts.terminals + counts.jobs} active`;
}
