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

import { errorToShow } from "@/lib/error-utils";
import { formatWhen } from "@/lib/utils";

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
 *
 * Russian says "1 минута" alone but "за 1 минуту" inside a sentence.
 */
export function spanWords(
  ms: number,
  t: T,
  use: "inSentence" | "alone" = "inSentence"
): string {
  if (ms >= DAY) return t("readings", "spanDays", { n: Math.floor(ms / DAY) });
  if (ms >= HOUR)
    return t("readings", "spanHours", { n: Math.floor(ms / HOUR) });
  return t(
    "readings",
    use === "alone" ? "spanMinutes" : "spanMinutesInSentence",
    { n: Math.max(1, Math.floor(ms / MINUTE)) }
  );
}

/**
 * How long a stretch of events lasted, never said shorter than it was: "within
 * 1 hour" for events 1 h 43 min apart understated the stretch by 40%. Two units
 * where one would round, the smaller one rounded up.
 */
export function coverWords(
  ms: number,
  t: T,
  use: "inSentence" | "alone" = "inSentence"
): string {
  const minuteKey = use === "alone" ? "spanMinutes" : "spanMinutesInSentence";
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  if (minutes < 60) return t("readings", minuteKey, { n: minutes });
  const both = (larger: string, rest: number, smaller: string) =>
    rest === 0 ? larger : t("readings", "spanAnd", { larger, smaller });
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return both(
      t("readings", "spanHours", { n: Math.floor(minutes / 60) }),
      rest,
      t("readings", minuteKey, { n: rest })
    );
  }
  const hours = Math.ceil(ms / HOUR);
  return both(
    t("readings", "spanDays", { n: Math.floor(hours / 24) }),
    hours % 24,
    t("readings", "spanHours", { n: hours % 24 })
  );
}

/** A moment by the clock, with the day in front of it whenever it is not today. */
export function momentWords(ms: number, now = Date.now()): string {
  const day = (at: number) => new Date(at).toDateString();
  return formatWhen(ms, day(ms) === day(now) ? "hourMinute" : "moment");
}

/** "a and b", "a, b, and c": the last join is a word, so it comes from the catalogue. */
export function listWords(names: readonly string[], t: T): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2)
    return t("nav", "twoAnd", { a: names[0], b: names[1] });
  return t("nav", "listAndLast", {
    list: names.slice(0, -1).join(", "),
    last: names[names.length - 1],
  });
}

/**
 * A {@link Saying}, in words.
 *
 * `spanMs` is resolved before the sentence rather than inside it: a duration
 * is itself counted words, and no language can hand another a substring of
 * its own plural. `coverMs` is a stretch events covered, said by
 * {@link coverWords}. A value named `<name>AtMs` is a moment, said as `{<name>}`.
 */
export function sayWords(saying: Saying, t: T): string {
  const source = saying.values ?? {};
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(source)) {
    values[name] =
      typeof value === "object"
        ? sayWords(value, t)
        : (value as string | number);
    if (name.endsWith("AtMs"))
      values[name.slice(0, -"AtMs".length)] = momentWords(Number(value));
  }
  if ("spanMs" in values) values.span = spanWords(Number(values.spanMs), t);
  if ("coverMs" in values) values.span = coverWords(Number(values.coverMs), t);
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
  return errorToShow(error);
}

/** Several sayings on one line, the way a summary reads them. */
export function joinSayings(parts: Saying[], t: T, separator = " · "): string {
  return parts.map((part) => sayWords(part, t)).join(separator);
}
