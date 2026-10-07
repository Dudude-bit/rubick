/**
 * Kubernetes Quantity Parsing and Formatting
 *
 * Unified module for parsing and formatting Kubernetes resource quantities.
 * Supports both CPU (cores/millicores) and Memory (bytes/Ki/Mi/Gi) formats.
 *
 * The grammar is Kubernetes' own `resource.Quantity`, read the same way by
 * `src/tauri/src/utils/quantities.rs`; `src/contracts/quantity-conformance.json`
 * is what keeps the two one answer.
 */

import { translate, type Locale } from "@/i18n";
import { currentLocale } from "@/stores/localeStore";
import { formatDecimal } from "@/lib/utils";

// Binary unit multipliers (Ki, Mi, Gi, Ti, Pi, Ei)
export const BINARY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

// Decimal unit multipliers. `k` in lower case only: `1K` is a string the API
// server refuses, and the backend never read it as a thousand.
export const DECIMAL_UNITS: Record<string, number> = {
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

export const CPU_UNITS: Record<string, number> = {
  n: 1e-9, // nanocores
  u: 1e-6, // microcores
  m: 1e-3, // millicores
};

const QUANTITY = /^([+-]?(?:\d+\.?\d*|\.\d+))(.*)$/;

/**
 * A quantity as Kubernetes reads it: a signed decimal number and then a
 * binary suffix, a decimal one, or an exponent (`1e3`, `12E-3`). `null` for
 * anything the API server would refuse.
 *
 * @param value - The quantity string (e.g., "500m", "1Gi", "2")
 * @returns Parsed number or null if invalid
 */
export function parseQuantity(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(QUANTITY);
  if (!match) return null;

  const amount = Number(match[1]);
  const suffix = match[2];
  if (suffix === "") return amount;

  // `1E` is an exabyte; `1E3` is a thousand.
  const exponent = suffix.match(/^[eE]([+-]?\d+)$/);
  if (exponent) return amount * 10 ** Number(exponent[1]);

  const factor =
    unitOf(CPU_UNITS, suffix) ??
    unitOf(BINARY_UNITS, suffix) ??
    unitOf(DECIMAL_UNITS, suffix);
  return factor === undefined ? null : amount * factor;
}

/** A table's own entry: `1toString` found `Object.prototype.toString` and parsed to NaN. */
function unitOf(
  table: Record<string, number>,
  suffix: string
): number | undefined {
  return Object.hasOwn(table, suffix) ? table[suffix] : undefined;
}

/**
 * Parse CPU quantity to millicores (number)
 * Supports formats: "500m", "0.5", "2", "2.5", "100n", "1000000u"
 *
 * @param cpuStr - CPU string value
 * @returns CPU in millicores (e.g., 500 for "500m")
 */
export function parseCPU(cpuStr: string | null | undefined): number {
  const cores = parseQuantity(cpuStr);
  return cores === null ? 0 : cores * 1000;
}

/**
 * Parse memory quantity to bytes (number)
 * Supports formats: "512Mi", "1Gi", "1024Ki", "1073741824", "100M", "1G"
 *
 * @param memStr - Memory string value
 * @returns Memory in bytes
 */
export function parseMemory(memStr: string | null | undefined): number {
  if (!memStr) return 0;
  // Read from the same table `parseQuantity` reads, which is what this file's
  // header has always claimed. The hand-rolled chain that used to live here
  // knew eight suffixes where the table knows thirteen, so `1Pi` matched
  // nothing, fell through to `parseFloat("1Pi")`, and a petabyte of declared
  // storage was reported as one byte. Its `endsWith("K") && !endsWith("Ki")`
  // guards could never fire either: a string ending in `Ki` does not end in
  // `K`.
  return parseQuantity(memStr) ?? 0;
}

/**
 * Millicores below a core, cores above it with one decimal so the unit is
 * unambiguous: "500m", "1.0", "2.5", in the reader's decimal mark.
 */
export function formatCPU(
  millicores: number,
  locale: Locale = currentLocale()
): string {
  if (millicores < 1000) return `${Math.round(millicores)}m`;
  return formatDecimal(millicores / 1000, 1, locale);
}

/** Whole cores to the millicore, so 465m reads 0,465 beside a 1,2 instead of changing unit. */
export function formatCores(
  millicores: number,
  locale: Locale = currentLocale()
): string {
  return formatDecimal(millicores / 1000, 3, locale, true);
}

const SIZE_KEYS = [
  "sizeB",
  "sizeKi",
  "sizeMi",
  "sizeGi",
  "sizeTi",
  "sizePi",
] as const;

/** The binary unit a byte count is read in: 0 for bytes, 1 for Ki, 2 for Mi. */
export function byteScale(bytes: number): number {
  if (!(bytes >= 1024)) return 0;
  return Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    SIZE_KEYS.length - 1
  );
}

export interface ByteFormat {
  /** Decimals past a whole kibibyte; bytes are always whole. */
  decimals?: number;
  /** Drop a fraction that is all zeros: "96Mi", not "96.0Mi". */
  trim?: boolean;
  /** Read in this scale rather than the count's own, so two numbers share a unit. */
  scale?: number;
  locale?: Locale;
}

/**
 * Every byte count the app prints, Kubernetes quantities and file sizes
 * alike: binary units, as kubectl and the API write them, in the reader's
 * decimal mark and unit names. "1.9Gi", «1,9 ГиБ».
 */
export function formatBytes(
  bytes: number,
  {
    decimals = 1,
    trim = false,
    scale = byteScale(bytes),
    locale = currentLocale(),
  }: ByteFormat = {}
): string {
  const n =
    scale === 0
      ? formatDecimal(bytes, 0, locale)
      : formatDecimal(bytes / 1024 ** scale, decimals, locale, trim);
  return translate(locale, "cluster", SIZE_KEYS[scale], { n });
}

/** A Kubernetes byte quantity for a person; one that does not parse is returned as written. */
export function formatKubernetesBytes(value: string): string {
  const bytes = parseQuantity(value);
  if (bytes === null || isNaN(bytes)) return value;
  return formatBytes(bytes, { trim: true });
}
