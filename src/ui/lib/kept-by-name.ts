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

const persisted = new Set<(context: string) => void>();

/**
 * Names a holder of what is persisted under a context name: pins, things
 * being watched for, the namespaces last used. It outlives the window, so it
 * is not let go on a kubeconfig change, where most names still mean the
 * cluster they did. It is told the one name that turned out not to.
 */
export function persistedByName(forget: (context: string) => void): () => void {
  persisted.add(forget);
  return () => void persisted.delete(forget);
}

/** `context` is another cluster than the one last seen under the name. */
export function nameIsAnotherCluster(context: string): void {
  for (const forget of [...persisted]) forget(context);
}
