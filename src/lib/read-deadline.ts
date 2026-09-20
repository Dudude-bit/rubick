/**
 * A read that took too long, and the one thing that makes the next one
 * shorter.
 *
 * Both numbers are the ones the Rust side applies: the deadline is a layer on
 * every kube client (`src-tauri/src/client/mod.rs`), and the sentence on
 * screen says the same number of seconds. `shared/read-deadlines.json` holds
 * the two equal, with a test on each side, the way the overview cap is held.
 */

/** After this the app stops waiting for one request and says so. */
export const LIST_DEADLINE_SECONDS = 60;

/** After this a skeleton says what it is waiting for and what would shorten it. */
export const SLOW_READ_MS = 8_000;

/**
 * The marker `Error::ReadDeadline` puts at the front of its message.
 *
 * Matched rather than the prose after it, and for the reason `credentials.ts`
 * gives: errors cross the Tauri boundary as their `Display` string and
 * nothing else, and sniffing English is how a refusal once read as a network
 * blip. Defined in `src-tauri/src/error.rs`.
 */
const MARKER = "READ_DEADLINE:";

export function isReadDeadline(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes(MARKER);
}

/**
 * The event the tab strip listens for: open the namespace picker of the
 * active tab. A list page that has run out of time offers the narrower
 * question, and the picker is where that question is asked.
 */
export const SCOPE_PICKER_OPEN = "scope-picker-open";

export function openNamespacePicker(): void {
  window.dispatchEvent(new CustomEvent(SCOPE_PICKER_OPEN));
}
