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

export function workloadStatus(ready: number, desired: number): WorkloadStatus {
  if (desired <= 0) return "Idle";
  return ready >= desired ? "Ready" : "Progressing";
}
