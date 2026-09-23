/**
 * Kubernetes Quantity Parsing and Formatting
 *
 * Unified module for parsing and formatting Kubernetes resource quantities.
 * Supports both CPU (cores/millicores) and Memory (bytes/Ki/Mi/Gi) formats.
 *
 * The grammar is Kubernetes' own `resource.Quantity`, read the same way by
 * `src-tauri/src/utils/quantities.rs`; `shared/quantity-conformance.json`
 * is what keeps the two one answer.
 */

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
    CPU_UNITS[suffix] ?? BINARY_UNITS[suffix] ?? DECIMAL_UNITS[suffix];
  return factor === undefined ? null : amount * factor;
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
 * Format CPU from millicores to string representation
 * Returns format like "500m" for < 1000 millicores, or "2" for >= 1000 millicores
 *
 * @param millicores - CPU in millicores
 * @returns Formatted CPU string
 */
export function formatCPU(millicores: number): string {
  if (millicores < 1000) {
    return `${Math.round(millicores)}m`;
  }

  // Always show one decimal for cores so the unit is unambiguous: "1.0",
  // "2.5". `${cores}` would produce "1" / "2.5" — inconsistent.
  const cores = millicores / 1000;
  return cores.toFixed(1);
}

/**
 * Format memory from bytes to human-readable string
 * Returns format like "512Mi", "1Gi", etc.
 *
 * @param bytes - Memory in bytes
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted memory string
 */
export function formatMemory(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0";

  const tib = bytes / BINARY_UNITS.Ti;
  if (tib >= 1) return `${tib.toFixed(decimals)}Ti`;

  const gib = bytes / BINARY_UNITS.Gi;
  if (gib >= 1) return `${gib.toFixed(decimals)}Gi`;

  const mib = bytes / BINARY_UNITS.Mi;
  if (mib >= 1) return `${mib.toFixed(decimals)}Mi`;

  const kib = bytes / BINARY_UNITS.Ki;
  if (kib >= 1) return `${kib.toFixed(decimals)}Ki`;

  return `${bytes}`;
}

/**
 * Format bytes to human-readable string (generic)
 *
 * @param bytes - Number of bytes
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  // Keep trailing zeros so the caller's `decimals` request is honoured
  // verbatim — `parseFloat(toFixed(2))` would silently turn "1.00" into "1".
  const value = (bytes / Math.pow(k, i)).toFixed(dm);

  return `${value} ${sizes[i]}`;
}

/**
 * Format Kubernetes bytes string to human-readable format
 *
 * @param value - Kubernetes quantity string
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted string or "-" if invalid
 */
export function formatKubernetesBytes(
  value: string | null | undefined,
  decimals: number = 1
): string {
  if (!value) return "-";

  const bytes = parseQuantity(value);
  if (bytes === null || isNaN(bytes)) return value;

  return formatBytes(bytes, decimals);
}
