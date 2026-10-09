import { type ClassValue, clsx } from "clsx";
import type { T } from "@/i18n/useT";
import { currentLocale } from "@/stores/localeStore";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with Tailwind CSS conflict resolution
 *
 * @param inputs - Class values to merge
 * @returns Merged class string with conflicts resolved
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * How long ago, in the compact notation the cluster's own tooling uses.
 *
 * In English that is `kubectl`'s `5d` / `2h` / `30m` / `10s`; another
 * language gets its own short units, «5 д.», «30 мин». Only the absence is
 * a word, so the translator comes in as an argument: this is called from
 * modules where a hook is not legal.
 */
export function formatAge(
  createdAt: string | null,
  t: T,
  locale: string = currentLocale()
): string {
  if (!createdAt) return t("cluster", "unknownAge");

  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return t("cluster", "unknownAge");
  return formatSince(created.getTime(), Date.now(), locale);
}

type TimeUnit = "day" | "hour" | "minute" | "second" | "millisecond";

const unitFormats = new Map<string, Intl.NumberFormat>();

/**
 * One number of one unit, in CLDR's narrow form for the reader's language.
 * English narrow units are `kubectl`'s, so `4m` stays `4m` there.
 */
export function formatTimeUnit(
  value: number,
  unit: TimeUnit,
  locale: string = currentLocale(),
  fractionDigits = 0
): string {
  const key = `${locale}|${unit}|${fractionDigits}`;
  let format = unitFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "narrow",
      useGrouping: false,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    unitFormats.set(key, format);
  }
  return format.format(value);
}

const decimalFormats = new Map<string, Intl.NumberFormat>();

/**
 * A plain number with `fractionDigits` decimals, in the reader's decimal
 * mark; `trim` drops the zeros a whole number would carry.
 */
export function formatDecimal(
  value: number,
  fractionDigits: number,
  locale: string = currentLocale(),
  trim = false
): string {
  const key = `${locale}|${fractionDigits}|${trim}`;
  let format = decimalFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      minimumFractionDigits: trim ? 0 : fractionDigits,
      maximumFractionDigits: fractionDigits,
      useGrouping: false,
    });
    decimalFormats.set(key, format);
  }
  return format.format(value);
}

/**
 * The same age as {@link formatAge}, from a timestamp and a clock the caller
 * owns: the largest whole unit only.
 */
export function formatSince(
  at: number,
  now: number,
  locale: string = currentLocale()
): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return formatTimeUnit(days, "day", locale);
  if (hours > 0) return formatTimeUnit(hours, "hour", locale);
  if (minutes > 0) return formatTimeUnit(minutes, "minute", locale);
  return formatTimeUnit(seconds, "second", locale);
}

/** A run's length in its two largest units: `2m 5s`, `1d 3h`, «2 мин 5 с». */
export function formatDuration(
  totalSeconds: number,
  locale: string = currentLocale()
): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const parts: [number, TimeUnit][] = [
    [Math.floor(s / 86400), "day"],
    [Math.floor(s / 3600) % 24, "hour"],
    [Math.floor(s / 60) % 60, "minute"],
    [s % 60, "second"],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return formatTimeUnit(0, "second", locale);
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => formatTimeUnit(n, unit, locale))
    .join(" ");
}

/**
 * How a moment is drawn. `moment` is the compact one a row has room for and
 * adds the year only when it is not this one; clocks are 24-hour, like the
 * log viewer's, so a column never grows an AM/PM it has no room for.
 */
export type WhenShape = "moment" | "full" | "day" | "clock" | "hourMinute";

const WHEN_SHAPES: Record<WhenShape, Intl.DateTimeFormatOptions> = {
  moment: {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  },
  full: { dateStyle: "medium", timeStyle: "medium" },
  day: { dateStyle: "medium" },
  clock: {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  },
  hourMinute: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
};

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** An `Intl.DateTimeFormat`, built once per language and shape. */
export function dateFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, format);
  }
  return format;
}

/**
 * A moment in the reader's language and zone: «4 окт., 08:27» where English
 * reads "Oct 4, 08:27 AM". Something that is not a date is shown as written.
 */
export function formatWhen(
  at: number | string | Date,
  shape: WhenShape = "full",
  locale: string = currentLocale()
): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return String(at);
  const options =
    shape === "moment" && date.getFullYear() !== new Date().getFullYear()
      ? { ...WHEN_SHAPES.moment, year: "numeric" as const }
      : WHEN_SHAPES[shape];
  return dateFormat(locale, options).format(date);
}

/** {@link formatWhen} for a field that may hold anything, or nothing. */
export function formatDate(
  value: unknown,
  locale: string = currentLocale()
): string | null {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatWhen(date, "full", locale);
}

/**
 * Calculate days until a future date
 *
 * @param dateValue - Date string or unknown value
 * @returns Number of days until the date, or null if invalid
 */
export function daysUntil(dateValue: unknown): number | null {
  if (!dateValue || typeof dateValue !== "string") return null;

  try {
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return null;

    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    // Rounded down, like `expiryOf` in `lib/certificates.ts` — the rule every
    // other certificate surface follows. Rounding up here made the
    // cert-manager column say "4 days" about the certificate the Ingress and
    // Secret screens called "3 days", at the same instant. Down is also the
    // honest reading: 3.2 days left is three whole days.
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

/**
 * Parse Kubernetes version string and check if it meets minimum version requirement
 *
 * @param version - Kubernetes version string (e.g., "v1.28.0", "1.25.3")
 * @param minMajor - Minimum required major version
 * @param minMinor - Minimum required minor version
 * @returns true if version meets requirement, true if version is unknown (assume supported)
 *
 * @example
 * isK8sVersionAtLeast("v1.28.0", 1, 25) // true
 * isK8sVersionAtLeast("v1.24.0", 1, 25) // false
 */
export function isK8sVersionAtLeast(
  version: string | undefined | null,
  minMajor: number,
  minMinor: number
): boolean {
  if (!version) return true; // If unknown, assume supported
  const match = version.match(/v?(\d+)\.(\d+)/);
  if (!match) return true;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major > minMajor || (major === minMajor && minor >= minMinor);
}
