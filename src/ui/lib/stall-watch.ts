import { startFrameWatch, type TaskSink } from "@/lib/perf-frames";
import { rowsOf, type PerfReport, type PerfSample } from "@/lib/perf";

/** What the reader did last: a key in a field, a key elsewhere, a press on something. */
export type StallInput =
  | { kind: "typing"; field: string | null; at: number }
  | { kind: "key"; key: string; at: number }
  | { kind: "click"; target: string | null; at: number };

/**
 * A main-thread stall: how long, when it ended, the address the window was
 * on, and the reader's input that came just before it, or `null` where none
 * did and the app was working on its own.
 */
export interface Stall {
  ms: number;
  at: number;
  where: string | null;
  input: StallInput | null;
}

/** One backend answer worth remembering: which command, how many rows. */
export interface BigAnswer {
  name: string;
  rows: number;
  at: number;
}

/**
 * A list on screen, by the label its table wears. The label is a kind's
 * plural and goes out untranslated; `null` where a table wears none, so the
 * sentence drops the word instead of printing an English one into it.
 */
export interface OpenList {
  label: string | null;
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
/** How long before a stall began an input still counts as what set it off. */
export const INPUT_LEAD_MS = 500;
const LABEL_CHARS = 40;

const FIELD = "input, textarea, select, [contenteditable]";
const PRESSABLE =
  'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="row"], [data-row-index], label';

const words = (text: string | null | undefined): string | null => {
  const flat = text?.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > LABEL_CHARS
    ? `${flat.slice(0, LABEL_CHARS - 1)}…`
    : flat;
};

const nameOf = (element: Element): string | null =>
  words(
    element.getAttribute("aria-label") ??
      element.getAttribute("placeholder") ??
      element.getAttribute("title") ??
      element.textContent
  );

/** An input event as the stall sheet says it. A typed character is never kept, only the field it went into. */
export function describeInput(
  event: Event | KeyboardEvent,
  at: number
): StallInput | null {
  const target =
    typeof Element !== "undefined" && event.target instanceof Element
      ? event.target
      : null;
  if ("key" in event) {
    if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return null;
    const field = target?.closest(FIELD);
    if (field) return { kind: "typing", field: nameOf(field), at };
    const chord = [
      event.ctrlKey && "Ctrl",
      event.altKey && "Alt",
      event.metaKey && "Meta",
      event.shiftKey && event.key.length > 1 && "Shift",
      event.key === " " ? "Space" : event.key,
    ].filter(Boolean);
    return { kind: "key", key: chord.join("+"), at };
  }
  const pressed = target?.closest(PRESSABLE) ?? target;
  return { kind: "click", target: pressed ? nameOf(pressed) : null, at };
}

const here = (): string | null =>
  typeof window === "undefined"
    ? null
    : `${window.location.pathname}${window.location.search}`;
/** How long a change waits for the rest of its burst before listeners hear of it. */
export const REPAINT_MS = 250;

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
  private input: StallInput | null = null;
  source: PerfReport["taskSource"] = "none";

  constructor(
    private now: () => number = () => performance.now(),
    private where: () => string | null = here
  ) {}

  /** The frame watch, pointed here instead of at the recorder, and the reader's input beside it. */
  start(host?: Parameters<typeof startFrameWatch>[1]): () => void {
    const sink: TaskSink = {
      record: (sample: PerfSample) => this.noteStall(sample.ms, sample.at),
      taskSource: "none",
    };
    const stop = startFrameWatch(sink, host);
    this.source = sink.taskSource;
    const heard = (event: Event) => {
      const input = describeInput(event, this.now());
      if (input) this.input = input;
    };
    const options = { capture: true, passive: true };
    const into = typeof window === "undefined" ? null : window;
    into?.addEventListener("keydown", heard, options);
    into?.addEventListener("pointerdown", heard, options);
    return () => {
      stop();
      into?.removeEventListener("keydown", heard, options);
      into?.removeEventListener("pointerdown", heard, options);
    };
  }

  noteInput(input: StallInput): void {
    this.input = input;
  }

  noteStall(ms: number, at: number = this.now()): void {
    const input =
      this.input && this.input.at >= at - ms - INPUT_LEAD_MS
        ? this.input
        : null;
    this.stalls.push({ ms, at, where: this.where(), input });
    if (this.stalls.length > KEEP) this.stalls.shift();
    this.notify();
  }

  /** Costs an `Array.isArray` and a length: never a walk over the value. */
  noteAnswer(name: string, value: unknown, at: number = this.now()): void {
    const rows = rowsOf(value);
    if (rows === undefined || rows < BIG_ANSWER_ROWS) return;
    this.answers.push({ name, rows, at });
    if (this.answers.length > KEEP) this.answers.shift();
    this.notify();
  }

  noteList(id: string, label: string | null, rows: number): void {
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
    this.input = null;
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
    }, REPAINT_MS);
  }
}

export const stallWatch = new StallWatch();
