import { type ClassValue, clsx } from "clsx";
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
 * Format age from a timestamp string
 *
 * @param createdAt - ISO timestamp string or null
 * @returns Formatted age string (e.g., "5d", "2h", "30m", "10s") or "Unknown"
 */
export function formatAge(createdAt: string | null): string {
  if (!createdAt) return "Unknown";

  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return "Unknown";
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const diffSecs = Math.max(0, Math.floor(diffMs / 1000));
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  if (diffMins > 0) return `${diffMins}m`;
  return `${diffSecs}s`;
}

/**
 * Format a date value for display
 *
 * @param value - Date string or unknown value
 * @returns Formatted date string or null
 */
export function formatDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value !== "string") return null;

  try {
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleString();
  } catch {
    return null;
  }
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
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
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
