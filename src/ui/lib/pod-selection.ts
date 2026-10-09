/**
 * Which pod's logs to show, given what the reader picked and what exists.
 *
 * The reader's choice wins for as long as it is a pod this workload has.
 * When it is not — they walked to another Deployment, or the pod they were
 * watching was rolled away — the choice has gone stale and the first
 * available pod takes over.
 *
 * Named because the wrong rule here is invisible and permanent. The page
 * used to auto-select only while nothing was selected, so a stale name was
 * never replaced: `pods.find` returned undefined, the Logs tab rendered
 * nothing at all, and the effect that would have fixed it was gated on the
 * very value that was wrong. Nothing short of a reload recovered.
 */
export function podToShow(
  pods: Array<{ name: string }>,
  chosen: string | null
): string | null {
  if (pods.some((pod) => pod.name === chosen)) return chosen;
  return pods[0]?.name ?? null;
}
