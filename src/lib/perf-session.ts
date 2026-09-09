import { commands } from "@/lib/commands";
import { perf } from "@/lib/perf";
import type { PerfRecorder } from "@/lib/perf";
import { startFrameWatch } from "@/lib/perf-frames";

/**
 * One recording, owned here rather than by the panel that shows it: the
 * panel unmounts when Settings closes, and a recording that lost its frame
 * watch at that moment would report the scroll it was started to measure as
 * a smooth one.
 */
export type SessionPhase =
  "idle" | "starting" | "recording" | "stopping" | "stopped";

export interface SessionState {
  phase: SessionPhase;
  /** A backend call that failed, in the last transition. */
  error: string | null;
}

interface Backend {
  setRecording(on: boolean): Promise<void>;
  counters(): Promise<PerfRecorder["backend"]>;
}

const tauriBackend: Backend = {
  setRecording: (on) => commands.perfSetRecording(on),
  counters: () => commands.perfCounters(),
};

export class PerfSession {
  private state: SessionState = { phase: "idle", error: null };
  private stopFrames: (() => void) | null = null;
  private transition: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private recorder: PerfRecorder = perf,
    private backend: Backend = tauriBackend,
    private frames: (r: PerfRecorder) => () => void = startFrameWatch
  ) {}

  get current(): SessionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Serialised with any transition in flight, so a stop pressed during a start waits for it. */
  start(): Promise<void> {
    this.transition = this.transition.then(() => this.doStart());
    return this.transition;
  }

  stop(): Promise<void> {
    this.transition = this.transition.then(() => this.doStop());
    return this.transition;
  }

  private async doStart(): Promise<void> {
    if (this.state.phase === "recording") return;
    this.set({ phase: "starting", error: null });
    try {
      await this.backend.setRecording(true);
    } catch (error) {
      this.set({ phase: "idle", error: String(error) });
      return;
    }
    this.recorder.start();
    this.stopFrames = this.frames(this.recorder);
    this.set({ phase: "recording", error: null });
  }

  private async doStop(): Promise<void> {
    if (this.state.phase !== "recording") return;
    this.set({ phase: "stopping", error: null });
    this.stopFrames?.();
    this.stopFrames = null;
    let error: string | null = null;
    try {
      this.recorder.backend = await this.backend.counters();
    } catch (e) {
      error = String(e);
    }
    this.recorder.stop();
    try {
      await this.backend.setRecording(false);
    } catch (e) {
      // The backend may still be serialising every event; the panel offers
      // to try again rather than pretending the run is over.
      error = String(e);
    }
    this.set({ phase: "stopped", error });
  }

  /** Try the backend stop again after a failed one. */
  async retryBackendStop(): Promise<void> {
    if (this.state.phase !== "stopped" || !this.state.error) return;
    try {
      await this.backend.setRecording(false);
      this.set({ phase: "stopped", error: null });
    } catch (e) {
      this.set({ phase: "stopped", error: String(e) });
    }
  }

  private set(state: SessionState): void {
    this.state = state;
    for (const l of this.listeners) l();
  }
}

export const perfSession = new PerfSession();
