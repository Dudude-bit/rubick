/**
 * Frontend logger - sends logs to the Rust backend via the log queue
 */

import { logQueue, type LogLevel } from "@/lib/log-queue";

export type { LogLevel } from "@/lib/log-queue";

export interface LogOptions {
  context?: string;
  data?: unknown;
}

const serializeError = (value: unknown) => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
};

/**
 * Log an event to the backend
 */
export function logEvent(
  level: LogLevel,
  message: string,
  options?: LogOptions
) {
  const context = options?.context;
  const data =
    options?.data !== undefined ? serializeError(options.data) : undefined;

  logQueue.enqueue({ level, message, context, data });
}

export const logDebug = (message: string, options?: LogOptions) =>
  logEvent("debug", message, options);

export const logInfo = (message: string, options?: LogOptions) =>
  logEvent("info", message, options);

export const logWarn = (message: string, options?: LogOptions) =>
  logEvent("warn", message, options);

export const logError = (message: string, options?: LogOptions) =>
  logEvent("error", message, options);

export { flushLogs } from "@/lib/log-queue";
