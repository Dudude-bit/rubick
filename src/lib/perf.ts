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
  /** Every sample since the recording started, evicted or not. */
  count: number;
  /** How many of them the percentiles were taken over. */
  sampled: number;
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
  /** Percentiles come from at most this many recent samples per kind. */
  sampleCap: number;
  backend?: BackendCounters;
}

/** The Rust side's own counters, read through a command. */
export interface BackendCounters {
  eventsEmitted: number;
  eventBytes: number;
  maxEventBytes: number;
  watchChanges: number;
}

/** Most recent samples kept per kind for percentiles. Totals and maxima never evict. */
export const SAMPLE_CAP = 5000;

/** A frame late by more than this is a long task, the platform's own bar. */
export const LONG_TASK_MS = 50;

/** One IPC message, as `shared/ipc-budget.json` states it; a test on each side holds them equal. */
export const IPC_TARGET_BYTES = 262_144;
export const IPC_LIMIT_BYTES = 1_048_576;

/** How long listeners wait between notifications while samples stream in. */
export const NOTIFY_EVERY_MS = 250;

/** Nearest-rank percentile over an ascending list; 0 for an empty one. */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}

interface Lifetime {
  count: number;
  totalMs: number;
  max: number;
  maxRows?: number;
  maxBytes?: number;
}

function fold(into: Lifetime, s: PerfSample): void {
  into.count += 1;
  into.totalMs += s.ms;
  if (s.ms > into.max) into.max = s.ms;
  if (s.rows !== undefined) into.maxRows = Math.max(into.maxRows ?? 0, s.rows);
  if (s.bytes !== undefined)
    into.maxBytes = Math.max(into.maxBytes ?? 0, s.bytes);
}

function stats(lifetime: Lifetime, window: readonly PerfSample[]): PerfStats {
  const sorted = window.map((s) => s.ms).sort((a, b) => a - b);
  return {
    count: lifetime.count,
    sampled: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: lifetime.max,
    totalMs: lifetime.totalMs,
    ...(lifetime.maxRows !== undefined ? { maxRows: lifetime.maxRows } : {}),
    ...(lifetime.maxBytes !== undefined ? { maxBytes: lifetime.maxBytes } : {}),
  };
}

/** The most recent `cap` samples in arrival order; older ones are overwritten in place. */
class Ring {
  private slots: PerfSample[] = [];
  private next = 0;
  constructor(private cap: number) {}
  push(s: PerfSample): void {
    if (this.slots.length < this.cap) this.slots.push(s);
    else this.slots[this.next] = s;
    this.next = (this.next + 1) % this.cap;
  }
  get length(): number {
    return this.slots.length;
  }
  toArray(): PerfSample[] {
    if (this.slots.length < this.cap) return this.slots.slice();
    return [...this.slots.slice(this.next), ...this.slots.slice(0, this.next)];
  }
}

function summariseByName(
  window: readonly PerfSample[],
  lifetimes: Map<string, Lifetime>
): Record<string, PerfStats> {
  const byName = new Map<string, PerfSample[]>();
  for (const s of window) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }
  const out: Record<string, PerfStats> = {};
  for (const [name, lifetime] of lifetimes) {
    out[name] = stats(lifetime, byName.get(name) ?? []);
  }
  return out;
}

type Listener = () => void;

export class PerfRecorder {
  private rings = this.freshRings();
  private lifetimes = this.freshLifetimes();
  private listeners = new Set<Listener>();
  private startedAt: Date | null = null;
  private startedAtMs = 0;
  private stoppedAtMs: number | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every start, so a sample from an earlier run can tell it is late. */
  generation = 0;
  taskSource: PerfReport["taskSource"] = "none";
  backend: BackendCounters | undefined;

  private freshRings(): Record<PerfKind, Ring> {
    return {
      ipc: new Ring(SAMPLE_CAP),
      task: new Ring(SAMPLE_CAP),
      render: new Ring(SAMPLE_CAP),
    };
  }

  private freshLifetimes(): Record<PerfKind, Map<string, Lifetime>> {
    return { ipc: new Map(), task: new Map(), render: new Map() };
  }

  get recording(): boolean {
    return this.startedAt !== null && this.stoppedAtMs === null;
  }

  start(now: number = performance.now()): void {
    this.rings = this.freshRings();
    this.lifetimes = this.freshLifetimes();
    this.backend = undefined;
    this.startedAt = new Date();
    this.startedAtMs = now;
    this.stoppedAtMs = null;
    this.generation += 1;
    this.notifyNow();
  }

  stop(now: number = performance.now()): void {
    if (!this.recording) return;
    this.stoppedAtMs = now;
    this.notifyNow();
  }

  record(sample: PerfSample): void {
    if (!this.recording) return;
    this.rings[sample.kind].push(sample);
    const lifetimes = this.lifetimes[sample.kind];
    const lifetime = lifetimes.get(sample.name);
    if (lifetime) fold(lifetime, sample);
    else {
      const fresh: Lifetime = { count: 0, totalMs: 0, max: 0 };
      fold(fresh, sample);
      lifetimes.set(sample.name, fresh);
    }
    this.notifyLater();
  }

  count(kind: PerfKind): number {
    let n = 0;
    for (const l of this.lifetimes[kind].values()) n += l.count;
    return n;
  }

  report(now: number = performance.now()): PerfReport | null {
    if (this.startedAt === null) return null;
    const end = this.stoppedAtMs ?? now;
    const tasks = this.rings.task.toArray();
    const taskLifetime = [
      ...this.lifetimes.task.values(),
    ].reduce<Lifetime | null>((acc, l) => {
      if (!acc) return { ...l };
      acc.count += l.count;
      acc.totalMs += l.totalMs;
      acc.max = Math.max(acc.max, l.max);
      return acc;
    }, null);
    return {
      startedAt: this.startedAt.toISOString(),
      durationMs: Math.round(end - this.startedAtMs),
      ipc: summariseByName(this.rings.ipc.toArray(), this.lifetimes.ipc),
      tasks: taskLifetime ? stats(taskLifetime, tasks) : null,
      renders: summariseByName(
        this.rings.render.toArray(),
        this.lifetimes.render
      ),
      taskSource: this.taskSource,
      sampleCap: SAMPLE_CAP,
      ...(this.backend ? { backend: this.backend } : {}),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyNow(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    for (const l of this.listeners) l();
  }

  private notifyLater(): void {
    if (this.pending || this.listeners.size === 0) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      for (const l of this.listeners) l();
    }, NOTIFY_EVERY_MS);
  }
}

export const perf = new PerfRecorder();

const utf8 = new TextEncoder();

/**
 * Shape of an answer, for the sample. Serialising is the cost this whole
 * module hides behind `recording`; a value that cannot be serialised (a
 * cycle, a BigInt) simply has no byte count. Bytes are UTF-8, the wire's
 * unit, not string length.
 */
export function sizeOf(value: unknown): { rows?: number; bytes?: number } {
  const rows = Array.isArray(value) ? value.length : undefined;
  let bytes: number | undefined;
  try {
    const text = JSON.stringify(value);
    bytes = text === undefined ? 0 : utf8.encode(text).byteLength;
  } catch {
    bytes = undefined;
  }
  return {
    ...(rows !== undefined ? { rows } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

/**
 * Time one IPC call into the recorder. Only called while recording; a call
 * that outlives the recording it started in, or lands in the next one, is
 * dropped rather than counted against a run it did not belong to.
 */
export async function measured<T>(
  name: string,
  run: () => Promise<T>,
  recorder: PerfRecorder = perf
): Promise<T> {
  const generation = recorder.generation;
  const started = performance.now();
  const value = await run();
  if (!recorder.recording || recorder.generation !== generation) return value;
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
