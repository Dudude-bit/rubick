/**
 * A line the app will say, named rather than written.
 *
 * Some copy is composed where the reader's language is not in scope — inside
 * a query function, in a module-level table read once at import. A sentence
 * chosen there is frozen: switch to Russian and it keeps whatever language
 * happened to be first, until something unrelated causes a refetch. Putting
 * the locale in the query key would fix the words and refetch the cluster to
 * do it, which is the wrong trade for a language toggle.
 *
 * A key survives all of that. The value is resolved at render, where the
 * translator lives.
 *
 * @module i18n/say
 */

import type { en } from "./catalogue";
import type { T } from "./useT";

export interface Saying {
  key: keyof (typeof en)["readings"];
  /**
   * A value may itself be a {@link Saying}: "1 expires in 4 days" is one
   * sentence built from two, and the inner one has to be chosen in the
   * reader's language before the outer one can hold it.
   */
  values?: Record<string, string | number | Saying>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A duration in the reader's language: "4 days", "11 hours", "2 minutes".
 *
 * One unit, never two. "1 day 3 hours" is a precision nobody acts on, and
 * the rounding is deliberate: a certificate with 23 hours left says hours,
 * because "0 days" is the answer that reads as fine.
 */
export function spanWords(ms: number, t: T): string {
  if (ms >= DAY) return t("readings", "spanDays", { n: Math.floor(ms / DAY) });
  if (ms >= HOUR)
    return t("readings", "spanHours", { n: Math.floor(ms / HOUR) });
  return t("readings", "spanMinutes", {
    n: Math.max(1, Math.floor(ms / MINUTE)),
  });
}

/**
 * A {@link Saying}, in words.
 *
 * `spanMs` is resolved before the sentence rather than inside it: a duration
 * is itself counted words, and no language can hand another a substring of
 * its own plural.
 */
export function sayWords(saying: Saying, t: T): string {
  const source = saying.values ?? {};
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(source)) {
    values[name] =
      typeof value === "object"
        ? sayWords(value, t)
        : (value as string | number);
  }
  if ("spanMs" in values) values.span = spanWords(Number(values.spanMs), t);
  return t("readings", saying.key, values);
}

/**
 * A failure the app itself worded, carried so it can be worded again.
 *
 * A thrown `Error` is a string, and by the time it reaches the toast that
 * shows it there is nothing left to translate. This keeps the key beside the
 * message: `error.message` stays English for the console and the stack
 * trace, and {@link errorWords} says the same thing to the reader.
 */
export class SaidError extends Error {
  constructor(
    readonly saying: Saying,
    message: string
  ) {
    super(message);
    this.name = "SaidError";
  }
}

/** What to show a reader about a caught error. */
export function errorWords(error: unknown, t: T): string {
  if (error instanceof SaidError) return sayWords(error.saying, t);
  return error instanceof Error ? error.message : String(error);
}

/** Several sayings on one line, the way a summary reads them. */
export function joinSayings(parts: Saying[], t: T, separator = " · "): string {
  return parts.map((part) => sayWords(part, t)).join(separator);
}
