/**
 * The one word a workload's replica counts add up to.
 *
 * One place, because it was two and they disagreed. The Deployments list read
 * `available === desired` and the peek panel read `desired > 0 && ready >=
 * desired`, so a Deployment scaled to zero was badged **Available** with a
 * green tick in the list and **Progressing** with a blue clock in the panel —
 * the same object, opened two ways in the same second, wearing opposite
 * verdicts.
 *
 * Neither was right about zero. Nothing is progressing toward a count of
 * none, and a workload with no pods is not "available" in any sense a reader
 * would recognise. `Idle` is the word for it, and `statusRole` already knows
 * it as neutral — which is what a deliberate scale-down deserves: not a
 * fault, not health, just a state somebody chose.
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
 * It also has to be one choice rather than a caller's. The Deployments list
 * passed `available` and the peek passed `ready` into a parameter named
 * `ready`, so the same Deployment mid-rollout read `Progressing` in the list
 * and `Ready` in the panel opened from it — the disagreement this module was
 * written to end, reappearing inside its own callers.
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
