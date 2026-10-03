/**
 * The one word a workload's replica counts add up to.
 *
 * One place, because the list and the peek panel each derived it and disagreed
 * about a workload scaled to zero. Zero desired is `Idle`: nothing is
 * progressing toward a count of none, and a workload with no pods is not
 * "available" in any sense a reader would recognise. `statusRole` already
 * knows `Idle` as neutral, which is what a deliberate scale-down deserves.
 *
 * The text is the colour: `statusRole` looks these words up, so they are
 * codes and stay untranslated. The translated label goes in the badge's
 * children.
 */
export type WorkloadStatus = "Ready" | "Progressing" | "Idle";

/**
 * `available` is taken over `ready` where a workload reports both.
 *
 * They are different numbers and the gap is real: `minReadySeconds` holds a
 * pod out of `available` after it is `ready`, and the Deployment controller
 * counts availability, not readiness, when it decides it is done. Reading
 * `ready` there is the optimistic answer.
 *
 * The choice is made here rather than left to the caller: passing the number
 * in is how the same Deployment mid-rollout read `Progressing` in the list and
 * `Ready` in the panel opened from it.
 */
export function workloadStatus(counts: {
  desired: number;
  ready: number;
  available?: number;
}): WorkloadStatus {
  if (counts.desired <= 0) return "Idle";
  const serving = counts.available ?? counts.ready;
  return serving >= counts.desired ? "Ready" : "Progressing";
}
