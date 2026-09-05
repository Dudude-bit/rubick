/**
 * Auto-updating age and countdown displays.
 *
 * The refresh rate follows the value: the shared tick store batches every
 * subscriber on one channel into a single timer.
 *
 * @module hooks/useRealtimeAge
 */

import { useSyncExternalStore, useCallback } from "react";
import { tickStore, type TickChannel } from "@/stores/tickStore";
import { formatAge } from "@/lib/utils";
import { useT } from "@/i18n/useT";

function getChannelForAge(ageSeconds: number): TickChannel {
  if (ageSeconds < 60) return "fast"; // < 1 minute: update every 1s
  if (ageSeconds < 3600) return "medium"; // < 1 hour: update every 10s
  return "slow"; // >= 1 hour: update every 60s
}

function getAgeSeconds(timestamp: string | null): number {
  if (!timestamp) return 0;
  const created = new Date(timestamp);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - created.getTime()) / 1000));
}

/**
 * Real-time age, refreshed at a rate that follows the age itself.
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
  const ageSeconds = getAgeSeconds(timestamp);
  const channel = getChannelForAge(ageSeconds);

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

  // Result unused: subscribing re-renders on each tick, and that render is
  // what recomputes the age.
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return formatAge(timestamp, t);
}

function formatCountdown(seconds: number): string {
  // Empty, not a word: this formats a duration, and "expired" is not one — it
  // went into `t("action", "inTime", {time})` and reached a Russian reader as
  // «через expired». The sentence for a passed moment is the caller's, off
  // `isExpired`.
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

function getRemainingSeconds(targetDate: string | Date | null): number {
  if (!targetDate) return 0;
  const target =
    typeof targetDate === "string" ? new Date(targetDate) : targetDate;
  if (Number.isNaN(target.getTime())) return 0;
  return Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000));
}

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
 * Real-time countdown to a target date.
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

  // Result unused: subscribing re-renders on each tick, and that render is
  // what recomputes the remainder.
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const remaining = getRemainingSeconds(targetDate);
  const remainingDays = remaining / 86400;

  // Nothing to count down to is not a countdown that ran out. A `targetDate`
  // of `null` measures as zero seconds, and reading that as expired paints a
  // deadline nobody set in the colour of one that has passed.
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
