/**
 * Log queue with batching and retry mechanism
 *
 * Buffers log entries in memory and sends them to the backend in batches.
 * Includes retry logic with exponential backoff for reliability.
 */

import { commands } from "@/lib/commands";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  data?: unknown;
  timestamp: number;
  retries: number;
}

export interface LogQueueStatus {
  queueSize: number;
  failedCount: number;
  isFlushing: boolean;
  lastFlushTime: number | null;
  lastError: string | null;
}

const MAX_RETRIES = 3;
const BATCH_DELAY_MS = 100;
const MAX_QUEUE_SIZE = 500;
const RETRY_BASE_DELAY_MS = 200;

class LogQueueImpl {
  private queue: LogEntry[] = [];
  private failedLogs: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;
  private lastFlushTime: number | null = null;
  private lastError: string | null = null;

  constructor() {
    // Flush on page unload
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        this.flushSync();
      });

      // Also flush on visibility change (tab hidden)
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.flush().catch(() => {});
        }
      });
    }
  }

  /**
   * Add a log entry to the queue
   */
  enqueue(entry: Omit<LogEntry, "timestamp" | "retries">): void {
    const fullEntry: LogEntry = {
      ...entry,
      timestamp: Date.now(),
      retries: 0,
    };

    this.queue.push(fullEntry);

    // Prevent queue from growing too large
    if (this.queue.length > MAX_QUEUE_SIZE) {
      // Keep the most recent entries, drop oldest
      const dropped = this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
      console.warn(`[LogQueue] Dropped ${dropped.length} old log entries`);
    }

    this.scheduleFlush();
  }

  /**
   * Flush all queued logs to the backend
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) {
      return;
    }

    this.isFlushing = true;
    this.cancelScheduledFlush();

    const entriesToSend = [...this.queue];
    this.queue = [];

    try {
      await this.sendBatch(entriesToSend);
      this.lastFlushTime = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unknown error";
      // Re-enqueue failed entries for retry
      this.handleFailedBatch(entriesToSend);
    } finally {
      this.isFlushing = false;
    }

    // Process any entries that accumulated during flush
    if (this.queue.length > 0) {
      this.scheduleFlush();
    }
  }

  /**
   * Synchronous flush for beforeunload - best effort
   */
  private flushSync(): void {
    if (this.queue.length === 0) {
      return;
    }

    // Store in localStorage as backup if we can't send synchronously
    try {
      const key = `k8s-gui-pending-logs-${Date.now()}`;
      const data = JSON.stringify(this.queue.slice(0, 50)); // Limit size
      localStorage.setItem(key, data);

      this.cleanupOldPendingLogs();
    } catch {
      // localStorage might be full or unavailable
    }
  }

  /**
   * Get queue status for diagnostics
   */
  getStatus(): LogQueueStatus {
    return {
      queueSize: this.queue.length,
      failedCount: this.failedLogs.length,
      isFlushing: this.isFlushing,
      lastFlushTime: this.lastFlushTime,
      lastError: this.lastError,
    };
  }

  /**
   * Recover logs from localStorage (from previous session crashes)
   */
  async recoverPendingLogs(): Promise<number> {
    if (typeof window === "undefined") {
      return 0;
    }

    let recovered = 0;
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("k8s-gui-pending-logs-")) {
        try {
          const data = localStorage.getItem(key);
          if (data) {
            const entries = JSON.parse(data) as LogEntry[];
            for (const entry of entries) {
              this.queue.push({ ...entry, retries: 0 });
              recovered++;
            }
          }
          keysToRemove.push(key);
        } catch {
          keysToRemove.push(key);
        }
      }
    }

    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }

    if (recovered > 0) {
      this.scheduleFlush();
    }

    return recovered;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, BATCH_DELAY_MS);
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async sendBatch(entries: LogEntry[]): Promise<void> {
    // Convert entries to the format expected by the batch command
    const batchEntries = entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      context: entry.context ?? undefined,
      data: entry.data,
      timestamp: entry.timestamp,
    }));

    // One IPC call for the batch, and a failure is left to travel. `flush`
    // owns the retry policy and calls `handleFailedBatch` on its way out; a
    // catch here used to be a verbatim copy of that method, so every failed
    // entry was queued twice and each retry doubled the buffer again.
    await commands.logFrontendEventsBatch(batchEntries);
  }

  private handleFailedBatch(entries: LogEntry[]): void {
    for (const entry of entries) {
      if (entry.retries < MAX_RETRIES) {
        this.failedLogs.push({ ...entry, retries: entry.retries + 1 });
      }
    }

    if (this.failedLogs.length > 0) {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.failedLogs.length === 0) {
      return;
    }

    const maxRetries = Math.max(...this.failedLogs.map((e) => e.retries));
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, maxRetries - 1);

    setTimeout(() => {
      const toRetry = [...this.failedLogs];
      this.failedLogs = [];

      for (const entry of toRetry) {
        this.queue.push(entry);
      }

      this.scheduleFlush();
    }, delay);
  }

  private cleanupOldPendingLogs(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("k8s-gui-pending-logs-")) {
        const timestamp = parseInt(key.split("-").pop() || "0", 10);
        if (timestamp < oneHourAgo) {
          keysToRemove.push(key);
        }
      }
    }

    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  }
}

// Singleton instance
export const logQueue = new LogQueueImpl();

/**
 * Force flush all pending logs
 */
export function flushLogs(): Promise<void> {
  return logQueue.flush();
}

/**
 * Get current queue status for diagnostics
 */
export function getLogQueueStatus(): LogQueueStatus {
  return logQueue.getStatus();
}

/**
 * Recover logs from previous session that may have been lost
 */
export function recoverPendingLogs(): Promise<number> {
  return logQueue.recoverPendingLogs();
}
