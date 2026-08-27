/**
 * Reading a cron expression, so the CronJob page does not have to.
 *
 * The schedule, the last run and the next run are what that page exists to
 * answer, and a raw six-hourly expression answers none of them at a glance.
 * There is no `nextScheduleTime` in the API response and no cron dependency
 * in the bundle, so the next occurrence is computed here.
 */

import type { T } from "@/i18n/useT";

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** The literal field text, kept so the description can spot a bare `*`. */
  raw: [string, string, string, string, string];
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** Index matches the cron value, so month 1 is January and day 0 is Sunday. */
const MONTH_NAMES = [
  "",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Sunday first, because cron counts days from Sunday. */
const WEEKDAY_KEYS = [
  "weekdaySunday",
  "weekdayMonday",
  "weekdayTuesday",
  "weekdayWednesday",
  "weekdayThursday",
  "weekdayFriday",
  "weekdaySaturday",
] as const;

function parseField(
  field: string,
  min: number,
  max: number,
  names?: string[]
): Set<number> | null {
  const out = new Set<number>();

  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    let from: number;
    let to: number;

    if (range === "*") {
      from = min;
      to = max;
    } else {
      const bounds = range.split("-");
      if (bounds.length > 2) return null;
      const start = toNumber(bounds[0], names);
      const end = bounds.length === 2 ? toNumber(bounds[1], names) : start;
      if (start === null || end === null) return null;
      from = start;
      // `5-1` is not a wrap-around in cron, it is a mistake.
      to = bounds.length === 2 ? end : stepText === undefined ? start : max;
      if (to < from) return null;
    }

    if (from < min || to > max) return null;
    for (let value = from; value <= to; value += step) out.add(value);
  }

  return out.size > 0 ? out : null;
}

function toNumber(token: string, names?: string[]): number | null {
  if (token === "") return null;
  const named = names?.indexOf(token.toLowerCase()) ?? -1;
  if (named > 0 || (named === 0 && names?.[0] !== "")) return named;
  const value = Number(token);
  return Number.isInteger(value) ? value : null;
}

export function parseCron(schedule: string): CronFields | null {
  const text = (MACROS[schedule.trim().toLowerCase()] ?? schedule)
    .trim()
    .split(/\s+/);
  if (text.length !== 5) return null;

  const minutes = parseField(text[0], 0, 59);
  const hours = parseField(text[1], 0, 23);
  const daysOfMonth = parseField(text[2], 1, 31);
  const months = parseField(text[3], 1, 12, MONTH_NAMES);
  const daysOfWeek = parseField(text[4], 0, 7, DAY_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  // Cron accepts both 0 and 7 for Sunday.
  if (daysOfWeek.has(7)) daysOfWeek.add(0);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    raw: [text[0], text[1], text[2], text[3], text[4]],
  };
}

/**
 * How far the wall clock in `timeZone` is ahead of UTC at a given instant.
 *
 * The walk below runs on wall-clock fields, so the instant is shifted into the
 * target zone and read back with the UTC accessors. An unknown zone name
 * throws inside `Intl`, in which case the browser's own zone is the honest
 * fallback.
 */
function zoneOffsetMs(instant: number, timeZone?: string | null): number {
  if (!timeZone) return -new Date(instant).getTimezoneOffset() * 60_000;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const at = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? "0");
    const asUtc = Date.UTC(
      at("year"),
      at("month") - 1,
      at("day"),
      at("hour") % 24,
      at("minute"),
      at("second")
    );
    return asUtc - (instant - (instant % 1000));
  } catch {
    return -new Date(instant).getTimezoneOffset() * 60_000;
  }
}

function dayMatches(fields: CronFields, wall: Date): boolean {
  const domRestricted = fields.raw[2] !== "*";
  const dowRestricted = fields.raw[4] !== "*";
  const dom = fields.daysOfMonth.has(wall.getUTCDate());
  const dow = fields.daysOfWeek.has(wall.getUTCDay());

  // With both fields restricted cron takes the union, not the intersection:
  // "1 * * 13 5" fires on the 13th *and* on every Friday.
  if (domRestricted && dowRestricted) return dom || dow;
  if (domRestricted) return dom;
  if (dowRestricted) return dow;
  return true;
}

const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * 60 * 1000;

/** The next instant this schedule fires, or null if it never does. */
export function nextCronRun(
  schedule: string,
  from: Date = new Date(),
  timeZone?: string | null
): Date | null {
  const fields = parseCron(schedule);
  if (!fields) return null;

  const start = from.getTime();
  const offset = zoneOffsetMs(start, timeZone);
  const wall = new Date(start + offset);
  wall.setUTCSeconds(0, 0);
  wall.setUTCMinutes(wall.getUTCMinutes() + 1);
  const limit = start + offset + SEARCH_LIMIT_MS;

  while (wall.getTime() <= limit) {
    if (!fields.months.has(wall.getUTCMonth() + 1)) {
      wall.setUTCMonth(wall.getUTCMonth() + 1, 1);
      wall.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(fields, wall)) {
      wall.setUTCDate(wall.getUTCDate() + 1);
      wall.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hours.has(wall.getUTCHours())) {
      wall.setUTCHours(wall.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minutes.has(wall.getUTCMinutes())) {
      wall.setUTCMinutes(wall.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    // Re-read the offset at the answer: a DST change between now and then
    // would otherwise slide the result by an hour.
    return new Date(
      wall.getTime() - zoneOffsetMs(wall.getTime() - offset, timeZone)
    );
  }

  return null;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function only(values: Set<number>): number | null {
  return values.size === 1 ? [...values][0] : null;
}

/** The step of a wildcard field, or null when it is a list or a range. */
function evenStep(
  raw: string,
  values: Set<number>,
  span: number
): number | null {
  if (raw === "*") return 1;
  const match = /^\*\/(\d+)$/.exec(raw);
  if (!match) return null;
  const step = Number(match[1]);
  return values.size === Math.ceil(span / step) ? step : null;
}

/**
 * The schedule in words, for the common shapes only.
 *
 * Returning null for anything unusual is deliberate: the raw expression is
 * always on screen next to this, and a wrong plain-English reading of it is
 * worse than none.
 */
export function describeCron(schedule: string, t: T): string | null {
  const fields = parseCron(schedule);
  if (!fields) return null;

  const [rawMin, rawHour, rawDom, rawMonth, rawDow] = fields.raw;
  const everyDay = rawDom === "*" && rawDow === "*" && rawMonth === "*";
  const minute = only(fields.minutes);
  const hour = only(fields.hours);

  const minuteStep = evenStep(rawMin, fields.minutes, 60);
  if (minuteStep && rawHour === "*" && everyDay) {
    return minuteStep === 1
      ? t("readings", "cronEveryMinute")
      : t("readings", "cronEveryMinutes", { n: minuteStep });
  }

  if (minute !== null && rawHour === "*" && everyDay) {
    return t("readings", "cronHourlyAt", {
      minute: String(minute).padStart(2, "0"),
    });
  }

  const hourStep = evenStep(rawHour, fields.hours, 24);
  if (minute !== null && hourStep && hourStep > 1 && everyDay) {
    return t("readings", "cronEveryHours", {
      n: hourStep,
      minute: String(minute).padStart(2, "0"),
    });
  }

  if (minute === null || hour === null) return null;

  if (everyDay)
    return t("readings", "cronDailyAt", { clock: clock(hour, minute) });

  if (rawDom === "*" && rawMonth === "*") {
    const day = only(fields.daysOfWeek);
    if (day !== null) {
      return t("readings", "cronWeeklyAt", {
        day: t("readings", WEEKDAY_KEYS[day % 7]),
        clock: clock(hour, minute),
      });
    }
    if (fields.raw[4] === "1-5")
      return t("readings", "cronWeekdaysAt", { clock: clock(hour, minute) });
    return null;
  }

  if (rawDow === "*" && rawMonth === "*") {
    const day = only(fields.daysOfMonth);
    if (day !== null) {
      return t("readings", "cronMonthlyAt", {
        day,
        clock: clock(hour, minute),
      });
    }
  }

  return null;
}
