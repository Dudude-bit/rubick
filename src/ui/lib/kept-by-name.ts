/**
 * What the window keeps under a context name and nothing else: the last
 * counts, the owners a read named, a baseline, a manifest being edited.
 *
 * A kubeconfig change can put another cluster behind a name, and every
 * holder named here lets go when one does. A holder not named here goes on
 * answering for the cluster that had the name before.
 */
const holders = new Set<() => void>();

/** Names a holder, and returns how to take it off again. */
export function keptByName(forget: () => void): () => void {
  holders.add(forget);
  return () => void holders.delete(forget);
}

/** The kubeconfig files changed: no name is known to be the cluster it was. */
export function namesRebound(): void {
  for (const forget of [...holders]) forget();
}
