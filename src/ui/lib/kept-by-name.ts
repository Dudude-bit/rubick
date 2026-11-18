import { logError } from "@/lib/logger";

/**
 * What the window keeps under a context name and nothing else: the last
 * counts, the owners a read named, a baseline, a manifest being edited.
 *
 * A kubeconfig change can put another cluster behind a name, and every
 * holder named here lets go when one does. A holder not named here goes on
 * answering for the cluster that had the name before.
 */
const holders = new Set<() => void>();

/** One holder let go: a throw from it, a store whose write failed, is logged and the rest are still told. */
function tell<T extends unknown[]>(forget: (...args: T) => void, ...args: T) {
  try {
    forget(...args);
  } catch (error) {
    logError("A holder kept by a context name could not let go", {
      context: "kept-by-name",
      data: { error },
    });
  }
}

/** Names a holder, and returns how to take it off again. */
export function keptByName(forget: () => void): () => void {
  holders.add(forget);
  return () => void holders.delete(forget);
}

/** The kubeconfig files changed: no name is known to be the cluster it was. */
export function namesRebound(): void {
  for (const forget of [...holders]) tell(forget);
}

const persisted = new Set<(context: string) => void>();
const turned = new Set<string>();

/**
 * Names a holder of what is persisted under a context name: pins, things
 * being watched for, the namespaces last used. It outlives the window, so it
 * is not let go on a kubeconfig change, where most names still mean the
 * cluster they did. It is told the one name that turned out not to, and,
 * named after that, every name that turned this session: a store first
 * loaded with a lazy screen still holds what it kept for the old cluster.
 */
export function persistedByName(forget: (context: string) => void): () => void {
  persisted.add(forget);
  for (const context of turned) tell(forget, context);
  return () => void persisted.delete(forget);
}

/** `context` is another cluster than the one last seen under the name. */
export function nameIsAnotherCluster(context: string): void {
  turned.add(context);
  for (const forget of [...persisted]) tell(forget, context);
}
