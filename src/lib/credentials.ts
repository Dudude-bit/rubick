/**
 * Whether the cluster still accepts the credentials this session was built
 * with — and the one place that decides it.
 *
 * A `401` is not an answer about the request that got it. Every request the
 * window makes afterwards gets the same one, because the token the client was
 * built with is simply not accepted any more: `prepare_kubeconfig_for_context`
 * runs the credential plugin once at connect and then strips the `exec` block
 * that could renew it. `auth::renew` runs the plugin again before the deadline
 * and replaces the client, which is why this is rarer than it was — but only
 * where the plugin named a deadline and could answer without a person, so the
 * screen it guards is still reachable. Nothing else notices — `isConnected` is set once
 * at connect, a count the cluster refused draws as nothing, and a list that
 * failed renders its *empty* state — so an expired token tells the reader, on
 * every screen at once, that their cluster has no pods in it. The failure this
 * module exists to end is the confident wrong answer, not a missing error
 * screen.
 *
 * A module and not a store because it is set from `lib/commands.ts`, the one
 * choke point every Tauri call already passes through: no per-surface wiring,
 * nothing to forget on the next command added. `clusterStore` imports
 * `commands`, so `commands` cannot import `clusterStore`; this imports nothing
 * and both sides may have it.
 */

/**
 * The marker `Error::CredentialsExpired` puts at the front of its message.
 *
 * Errors cross the Tauri boundary as their `Display` string and nothing else —
 * `error_code()` is not serialised — so this prefix is the wire format, and it
 * is matched rather than the prose after it. Sniffing the API server's own
 * English is how `isRetryableError` came to read every Ingress error as a
 * network blip. Defined in `src-tauri/src/error.rs`.
 */
const MARKER = "CREDENTIALS_EXPIRED:";

export function isCredentialsExpired(message: string): boolean {
  return message.includes(MARKER);
}

/** What went wrong, with this app's framing taken off. */
export function expiryReason(message: string): string {
  const at = message.indexOf(MARKER);
  if (at === -1) return message;
  return message.slice(at + MARKER.length).trim();
}

export interface ExpiredCredentials {
  /** The API server's own sentence. */
  reason: string;
  /** When this was noticed, so a surface can say how long ago. */
  at: number;
}

let expired: ExpiredCredentials | null = null;
const listeners = new Set<(state: ExpiredCredentials | null) => void>();

function publish() {
  for (const listener of listeners) listener(expired);
}

/**
 * Record that this context's session is over.
 *
 * First one wins until it is cleared: the window makes many requests at once
 * and they all fail together, so the reader is owed the first sentence rather
 * than whichever request happened to land last.
 */
export function credentialsExpired(reason: string): void {
  if (expired) return;
  expired = { reason, at: Date.now() };
  publish();
}

/** Cleared by a reconnect that worked, and by leaving the cluster. */
export function credentialsRestored(): void {
  if (!expired) return;
  expired = null;
  publish();
}

export function readExpiredCredentials(): ExpiredCredentials | null {
  return expired;
}

export function subscribeToCredentials(
  listener: (state: ExpiredCredentials | null) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * How many times a context's credentials have been replaced under the window.
 *
 * A renewal in `auth::renew` swaps the client every long-running read was
 * built on, and a `kube::Client` carries the token it was made with — so a
 * watch started an hour ago keeps using credentials about to be refused.
 * Anything holding one reads this and starts again.
 */
let renewals = 0;
const renewalListeners = new Set<() => void>();

/** Called from the backend's `credentials-renewed` event. */
export function credentialsRenewed(): void {
  renewals += 1;
  for (const listener of renewalListeners) listener();
}

export function readRenewals(): number {
  return renewals;
}

export function subscribeToRenewals(listener: () => void): () => void {
  renewalListeners.add(listener);
  return () => renewalListeners.delete(listener);
}
