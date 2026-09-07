/**
 * Performance recording: what the app spent its time on, with numbers a PR
 * can quote. Off until Diagnostics switches it on, and then every IPC round
 * trip, long task and profiled render lands here as one sample.
 *
 * Bytes are counted by serialising the answer a second time, which is why
 * nothing is measured while recording is off: the measurement must never be
 * the slow part of a screen nobody asked to measure.
 */

export type PerfKind = "ipc" | "task" | "render";

export interface PerfSample {
  kind: PerfKind;
  name: string;
  ms: number;
  /** `performance.now()` when the sample ended. */
  at: number;
  rows?: number;
  bytes?: number;
}

export interface PerfStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  totalMs: number;
  /** Largest answer seen, where the sample carried one. */
  maxRows?: number;
  maxBytes?: number;
}

export interface PerfReport {
  startedAt: string;
  durationMs: number;
  ipc: Record<string, PerfStats>;
  tasks: PerfStats | null;
  renders: Record<string, PerfStats>;
  /** How long tasks were observed: the platform observer, or frame gaps. */
  taskSource: "longtask" | "frame-gap" | "none";
  backend?: BackendCounters;
}

/** The Rust side's own counters, read through a command. */
export interface BackendCounters {
  eventsEmitted: number;
  eventBytes: number;
  maxEventBytes: number;
  watchChanges: number;
}

/** Most samples kept per kind; older ones fall off the front. */
export const SAMPLE_CAP = 5000;

/** A frame late by more than this is a long task, the platform's own bar. */
export const LONG_TASK_MS = 50;

/** Nearest-rank percentile over an ascending list; 0 for an empty one. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}

export function summarise(samples: readonly PerfSample[]): PerfStats {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  let maxRows: number | undefined;
  let maxBytes: number | undefined;
  for (const s of samples) {
    if (s.rows !== undefined) maxRows = Math.max(maxRows ?? 0, s.rows);
    if (s.bytes !== undefined) maxBytes = Math.max(maxBytes ?? 0, s.bytes);
  }
  return {
    count: samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    ...(maxRows !== undefined ? { maxRows } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  };
}

function groupByName(
  samples: readonly PerfSample[]
): Record<string, PerfStats> {
  const byName = new Map<string, PerfSample[]>();
  for (const s of samples) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }
  const out: Record<string, PerfStats> = {};
  for (const [name, list] of byName) out[name] = summarise(list);
  return out;
}

type Listener = () => void;

export class PerfRecorder {
  private samples: Record<PerfKind, PerfSample[]> = {
    ipc: [],
    task: [],
    render: [],
  };
  private listeners = new Set<Listener>();
  private startedAt: Date | null = null;
  private startedAtMs = 0;
  private stoppedAtMs: number | null = null;
  taskSource: PerfReport["taskSource"] = "none";
  backend: BackendCounters | undefined;

  get recording(): boolean {
    return this.startedAt !== null && this.stoppedAtMs === null;
  }

  start(now: number = performance.now()): void {
    this.samples = { ipc: [], task: [], render: [] };
    this.backend = undefined;
    this.startedAt = new Date();
    this.startedAtMs = now;
    this.stoppedAtMs = null;
    this.notify();
  }

  stop(now: number = performance.now()): void {
    if (!this.recording) return;
    this.stoppedAtMs = now;
    this.notify();
  }

  record(sample: PerfSample): void {
    if (!this.recording) return;
    const list = this.samples[sample.kind];
    list.push(sample);
    if (list.length > SAMPLE_CAP) list.splice(0, list.length - SAMPLE_CAP);
    this.notify();
  }

  count(kind: PerfKind): number {
    return this.samples[kind].length;
  }

  report(now: number = performance.now()): PerfReport | null {
    if (this.startedAt === null) return null;
    const end = this.stoppedAtMs ?? now;
    const tasks = this.samples.task;
    return {
      startedAt: this.startedAt.toISOString(),
      durationMs: Math.round(end - this.startedAtMs),
      ipc: groupByName(this.samples.ipc),
      tasks: tasks.length > 0 ? summarise(tasks) : null,
      renders: groupByName(this.samples.render),
      taskSource: this.taskSource,
      ...(this.backend ? { backend: this.backend } : {}),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

export const perf = new PerfRecorder();

/**
 * Shape of an answer, for the sample. Serialising is the cost this whole
 * module hides behind `recording`; a value that cannot be serialised (a
 * cycle, a BigInt) simply has no byte count.
 */
export function sizeOf(value: unknown): { rows?: number; bytes?: number } {
  const rows = Array.isArray(value) ? value.length : undefined;
  let bytes: number | undefined;
  try {
    const text = JSON.stringify(value);
    bytes = text === undefined ? 0 : text.length;
  } catch {
    bytes = undefined;
  }
  return {
    ...(rows !== undefined ? { rows } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

/** Time one IPC call into the recorder; a no-op while nothing records. */
export async function measured<T>(
  name: string,
  run: () => Promise<T>,
  recorder: PerfRecorder = perf
): Promise<T> {
  if (!recorder.recording) return run();
  const started = performance.now();
  const value = await run();
  const at = performance.now();
  recorder.record({
    kind: "ipc",
    name,
    ms: at - started,
    at,
    ...sizeOf(value),
  });
  return value;
}
