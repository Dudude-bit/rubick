/**
 * Whether the cluster still accepts the credentials this session was built
 * with — and the one place that decides it.
 *
 * ## Why this is not derived from a query
 *
 * A `401` is not an answer about the request that got it. Every request the
 * window makes afterwards gets the same one, because the token the client was
 * built with is simply not accepted any more: `prepare_kubeconfig_for_context`
 * runs the credential plugin once at connect and then strips the `exec` block
 * that could renew it, so a GKE session stops working about an hour in and
 * never recovers on its own.
 *
 * Nothing noticed. `isConnected` is set once at connect, so the rail kept its
 * green dot; a count the cluster refused draws as nothing, which is right
 * everywhere else and hid this; and a list that failed rendered its *empty*
 * state — so an expired token told the reader, on every screen at once, that
 * their cluster had no pods in it. That is the failure this module exists to
 * end: not a missing error screen, a confident wrong answer.
 *
 * ## Why a module and not a store
 *
 * It is set from `lib/commands.ts`, which every Tauri call in the app already
 * passes through — one choke point, no per-surface wiring, nothing to forget
 * on the next command added. `clusterStore` imports `commands`, so `commands`
 * cannot import `clusterStore`; this imports nothing and both sides may have
 * it.
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
