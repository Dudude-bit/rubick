/**
 * Real-Time Age Hook
 *
 * Provides auto-updating age display with adaptive refresh intervals.
 * Uses the global tick store for efficient batched updates.
 *
 * @module hooks/useRealtimeAge
 */

import { useSyncExternalStore, useCallback } from "react";
import { tickStore, type TickChannel } from "@/stores/tickStore";
import { formatAge } from "@/lib/utils";
import { useT } from "@/i18n/useT";

/**
 * Determine which tick channel to use based on age in seconds
 */
function getChannelForAge(ageSeconds: number): TickChannel {
  if (ageSeconds < 60) return "fast"; // < 1 minute: update every 1s
  if (ageSeconds < 3600) return "medium"; // < 1 hour: update every 10s
  return "slow"; // >= 1 hour: update every 60s
}

/**
 * Calculate age in seconds from a timestamp
 */
function getAgeSeconds(timestamp: string | null): number {
  if (!timestamp) return 0;
  const created = new Date(timestamp);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - created.getTime()) / 1000));
}

/**
 * Hook for real-time age updates with adaptive intervals
 *
 * Automatically determines the appropriate update frequency based on age:
 * - Seconds (< 60s): updates every 1s
 * - Minutes (< 1h): updates every 10s
 * - Hours/Days: updates every 60s
 *
 * @param timestamp - ISO timestamp string or null
 * @returns Current formatted age string (e.g., "5m", "2h", "3d")
 *
 * @example
 * ```tsx
 * const age = useRealtimeAge(pod.createdAt);
 * return <span>{age}</span>;
 * ```
 */
export function useRealtimeAge(timestamp: string | null): string {
  const t = useT();
  // Calculate initial age and channel
  const ageSeconds = getAgeSeconds(timestamp);
  const channel = getChannelForAge(ageSeconds);

  // Subscribe to the appropriate tick channel
  const subscribe = useCallback(
    (callback: () => void) => tickStore.subscribe(channel, callback),
    [channel]
  );

  const getSnapshot = useCallback(
    () => tickStore.getSnapshot(channel),
    [channel]
  );

  const getServerSnapshot = useCallback(
    () => tickStore.getServerSnapshot(channel),
    [channel]
  );

  // This will trigger re-render on each tick
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Recalculate age on each render (triggered by tick)
  return formatAge(timestamp, t);
}

/**
 * Format a countdown duration
 */
function formatCountdown(seconds: number): string {
  // Empty, not a word. This formats a duration, and "expired" is not one —
  // it went straight into `t("action", "inTime", {time})` and reached a
  // Russian reader as «через expired». What to say when the moment has
  // passed is the caller's sentence to write; `isExpired` is what it reads.
  if (seconds <= 0) return "";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  if (secs > 0 && days === 0 && hours === 0) parts.push(`${secs}s`);

  return parts.join(" ") || "0s";
}

/**
 * Calculate remaining seconds until a target date
 */
function getRemainingSeconds(targetDate: string | Date | null): number {
  if (!targetDate) return 0;
  const target =
    typeof targetDate === "string" ? new Date(targetDate) : targetDate;
  if (Number.isNaN(target.getTime())) return 0;
  return Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000));
}

/**
 * Determine tick channel for countdown based on remaining time
 */
function getChannelForCountdown(remainingSeconds: number): TickChannel {
  if (remainingSeconds <= 60) return "fast"; // Last minute: every 1s
  if (remainingSeconds <= 3600) return "medium"; // Last hour: every 10s
  return "slow"; // > 1 hour: every 60s
}

export interface CountdownResult {
  /** Formatted countdown string (e.g., "2d 5h 30m") */
  display: string;
  /** Whether the countdown has expired */
  isExpired: boolean;
  /** Remaining seconds */
  remainingSeconds: number;
  /** Warning level: "none" | "warning" | "critical" */
  warningLevel: "none" | "warning" | "critical";
}

/**
 * Hook for real-time countdown to a target date
 *
 * @param targetDate - ISO timestamp string or Date object for target
 * @param options - Configuration options
 * @param options.warningThresholdDays - Days before expiry to show warning (default: 7)
 * @param options.criticalThresholdDays - Days before expiry to show critical (default: 1)
 * @returns Countdown result with display, status, and warning level
 *
 * @example
 * ```tsx
 * const { display, isExpired, warningLevel } = useRealtimeCountdown(certificate.expiresAt);
 * return <span className={warningLevel === 'critical' ? 'text-err' : ''}>{display}</span>;
 * ```
 */
export function useRealtimeCountdown(
  targetDate: string | Date | null,
  options?: {
    warningThresholdDays?: number;
    criticalThresholdDays?: number;
  }
): CountdownResult {
  const { warningThresholdDays = 7, criticalThresholdDays = 1 } = options ?? {};

  const remainingSeconds = getRemainingSeconds(targetDate);
  const channel = getChannelForCountdown(remainingSeconds);

  const subscribe = useCallback(
    (callback: () => void) => tickStore.subscribe(channel, callback),
    [channel]
  );

  const getSnapshot = useCallback(
    () => tickStore.getSnapshot(channel),
    [channel]
  );

  const getServerSnapshot = useCallback(
    () => tickStore.getServerSnapshot(channel),
    [channel]
  );

  // This will trigger re-render on each tick
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Recalculate on each render (triggered by tick)
  const remaining = getRemainingSeconds(targetDate);
  const remainingDays = remaining / 86400;

  // Nothing to count down to is not a countdown that ran out. `targetDate` of
  // `null` measures as zero seconds, and reading that as expired paints a
  // deadline nobody set in the colour of one that has passed — the third state
  // folded into the second, in a hook a caller reads for a verdict.
  const targeted = targetDate !== null && targetDate !== undefined;

  let warningLevel: "none" | "warning" | "critical" = "none";
  if (!targeted) {
    warningLevel = "none";
  } else if (remaining <= 0) {
    warningLevel = "critical";
  } else if (remainingDays <= criticalThresholdDays) {
    warningLevel = "critical";
  } else if (remainingDays <= warningThresholdDays) {
    warningLevel = "warning";
  }

  return {
    display: formatCountdown(remaining),
    isExpired: targeted && remaining <= 0,
    remainingSeconds: remaining,
    warningLevel,
  };
}
