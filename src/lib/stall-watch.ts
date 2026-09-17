import { startFrameWatch, type TaskSink } from "@/lib/perf-frames";
import type { PerfReport, PerfSample } from "@/lib/perf";

/** A main-thread stall: how long, and when it ended. */
export interface Stall {
  ms: number;
  at: number;
}

/** One backend answer worth remembering: which command, how many rows. */
export interface BigAnswer {
  name: string;
  rows: number;
  at: number;
}

/** A list on screen, by the label its table wears. */
export interface OpenList {
  label: string;
  rows: number;
}

export interface StallReport {
  stalls: Stall[];
  longest: Stall | null;
  largest: BigAnswer | null;
  lists: OpenList[];
  source: PerfReport["taskSource"];
}

/** How far back a stall is still worth mentioning. */
export const STALL_WINDOW_MS = 60_000;
/** Under this a list is not the reason for anything. */
export const BIG_LIST_ROWS = 1_000;
/** Under this an answer is not the reason for anything. */
export const BIG_ANSWER_ROWS = 1_000;
const KEEP = 200;

/**
 * The cheap half of the performance recorder, always on: stalls of the
 * main thread from the same observer the recorder uses, the row counts of
 * backend answers (an array's length, never a serialisation), and the
 * lists on screen. Enough to say *what* is slow on a big cluster without
 * turning the recorder on; the recorder still owns *how much*.
 */
export class StallWatch {
  private stalls: Stall[] = [];
  private answers: BigAnswer[] = [];
  private lists = new Map<string, OpenList>();
  private listeners = new Set<() => void>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  source: PerfReport["taskSource"] = "none";

  constructor(private now: () => number = () => performance.now()) {}

  /** The frame watch, pointed here instead of at the recorder. */
  start(host?: Parameters<typeof startFrameWatch>[1]): () => void {
    const sink: TaskSink = {
      record: (sample: PerfSample) => this.noteStall(sample.ms, sample.at),
      taskSource: "none",
    };
    const stop = startFrameWatch(sink, host);
    this.source = sink.taskSource;
    return stop;
  }

  noteStall(ms: number, at: number = this.now()): void {
    this.stalls.push({ ms, at });
    if (this.stalls.length > KEEP) this.stalls.shift();
    this.notify();
  }

  /** Costs an `Array.isArray` and a length: never a walk over the value. */
  noteAnswer(name: string, value: unknown, at: number = this.now()): void {
    if (!Array.isArray(value) || value.length < BIG_ANSWER_ROWS) return;
    this.answers.push({ name, rows: value.length, at });
    if (this.answers.length > KEEP) this.answers.shift();
    this.notify();
  }

  noteList(id: string, label: string, rows: number): void {
    if (rows >= BIG_LIST_ROWS) this.lists.set(id, { label, rows });
    else this.lists.delete(id);
    this.notify();
  }

  forgetList(id: string): void {
    if (this.lists.delete(id)) this.notify();
  }

  /** Everything forgotten. One process holds one of these, so a test that
   *  wants an empty watch has to say so. */
  reset(): void {
    this.stalls = [];
    this.answers = [];
    this.lists.clear();
    this.notify();
  }

  report(now: number = this.now()): StallReport {
    const since = now - STALL_WINDOW_MS;
    const stalls = this.stalls.filter((s) => s.at >= since);
    const answers = this.answers.filter((a) => a.at >= since);
    return {
      stalls,
      longest: stalls.reduce<Stall | null>(
        (best, s) => (best === null || s.ms > best.ms ? s : best),
        null
      ),
      largest: answers.reduce<BigAnswer | null>(
        (best, a) => (best === null || a.rows > best.rows ? a : best),
        null
      ),
      lists: [...this.lists.values()].sort((a, b) => b.rows - a.rows),
      source: this.source,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Coalesced: a burst of stalls is one repaint, not one per stall. */
  private notify(): void {
    if (this.pending !== null) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      for (const listener of this.listeners) listener();
    }, 250);
  }
}

export const stallWatch = new StallWatch();
