/**
 * What the status-bar trigger calls itself.
 *
 * It said "N active", which names a category nobody is looking for. A reader
 * with a port-forward running is looking for the words "port forward", and a
 * count with no noun on a line of `dark · 239 pods · 8 problems` reads as more
 * status rather than the door to the thing.
 *
 * So when only one kind of activity is running — which is the common case —
 * the trigger says which. Only a genuine mixture falls back to the total,
 * because listing both does not fit an eleven-pixel line.
 *
 * The counting is the catalogue's job, not this file's: "1 проброс, 2 проброса,
 * 5 пробросов" is three forms chosen by the number, and the English
 * `n === 1 ? x : y` that used to live here could not express it.
 */

import { translate, type Locale } from "@/i18n";

export interface ActivityCounts {
  ports: number;
  terminals: number;
}

const KEYS = {
  ports: "portForwards",
  terminals: "terminalCount",
} as const;

export function activityLabel(
  counts: ActivityCounts,
  locale: Locale = "en"
): string {
  const running = (Object.keys(KEYS) as Array<keyof ActivityCounts>).filter(
    (kind) => counts[kind] > 0
  );

  if (running.length === 0) return translate(locale, "activity", "idle");

  if (running.length === 1) {
    const kind = running[0];
    return translate(locale, "activity", KEYS[kind], { n: counts[kind] });
  }

  return translate(locale, "activity", "active", {
    n: counts.ports + counts.terminals,
  });
}
