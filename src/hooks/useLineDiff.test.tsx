import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { computeLineDiff, SYNC_LINES } from "@/lib/line-diff";
import { useLineDiff } from "./useLineDiff";

function Probe({ original, modified }: { original: string; modified: string }) {
  const { lines, computing, failed } = useLineDiff(original, modified);
  return (
    <span data-testid="state">
      {failed
        ? "failed"
        : computing
          ? "computing"
          : `${lines.filter((l) => l.type !== "unchanged").length} changed`}
    </span>
  );
}

/** A Worker that answers like the real one, but on this thread and only when told. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners: Array<(event: MessageEvent) => void> = [];
  typed: Array<[string, (event: MessageEvent) => void]> = [];
  pending: Array<{ id: number; original: string; modified: string }> = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.typed.push([type, listener]);
    if (type === "message") this.listeners.push(listener);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.typed = this.typed.filter(([t, l]) => t !== type || l !== listener);
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  terminated = false;
  postMessage(request: { id: number; original: string; modified: string }) {
    this.pending.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  /** What the browser does when the worker itself dies. */
  breaks() {
    for (const [type, listener] of this.typed)
      if (type === "error") listener({} as MessageEvent);
  }
  /** What the worker posts when the diff itself threw. */
  fails(which = 0) {
    const request = this.pending.splice(which, 1)[0];
    const data = { id: request.id, lines: [], failed: "out of memory" };
    for (const listener of [...this.listeners])
      listener({ data } as MessageEvent);
  }
  answer(which = 0) {
    const request = this.pending.splice(which, 1)[0];
    const data = {
      id: request.id,
      lines: computeLineDiff(request.original, request.modified),
    };
    for (const listener of [...this.listeners])
      listener({ data } as MessageEvent);
  }
}

const big = (n: number, tail: string) =>
  Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + tail;

describe("where the diff is computed", () => {
  it("answers a small pair right here, with no worker at all", () => {
    // One line rewritten is one removed and one added.
    render(<Probe original={"a\nb"} modified={"a\nc"} />);
    expect(screen.getByTestId("state")).toHaveTextContent("2 changed");
  });

  describe("with a worker", () => {
    // One worker is shared by every viewer for the life of the module, so
    // the fake made by the first test is the one every later test talks to.
    beforeEach(() => {
      vi.stubGlobal("Worker", FakeWorker);
      for (const instance of FakeWorker.instances) instance.pending = [];
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /**
     * A big pair goes out and comes back; until it does the viewer knows it
     * is waiting rather than drawing nothing as "no changes".
     */
    it("sends a big pair to the worker and takes its answer", async () => {
      render(
        <Probe
          original={big(SYNC_LINES, "")}
          modified={big(SYNC_LINES, "\nextra")}
        />
      );
      expect(screen.getByTestId("state")).toHaveTextContent("computing");
      const worker = FakeWorker.instances[0];
      expect(worker.pending).toHaveLength(1);
      await act(async () => worker.answer());
      expect(screen.getByTestId("state")).toHaveTextContent("1 changed");
    });

    /**
     * Typing outruns the worker. An answer to the buffer as it was two
     * keystrokes ago must not be drawn over the buffer as it is now.
     */
    it("drops an answer to a question the caller has moved past", async () => {
      const { rerender } = render(
        <Probe
          original={big(SYNC_LINES, "")}
          modified={big(SYNC_LINES, "\none")}
        />
      );
      rerender(
        <Probe
          original={big(SYNC_LINES, "")}
          modified={big(SYNC_LINES, "\none\ntwo")}
        />
      );
      const worker = FakeWorker.instances[0];
      expect(worker.pending).toHaveLength(2);
      await act(async () => worker.answer(0));
      expect(screen.getByTestId("state")).toHaveTextContent("computing");
      await act(async () => worker.answer(0));
      expect(screen.getByTestId("state")).toHaveTextContent("2 changed");
    });

    /**
     * A worker that cannot answer is an outcome, not a wait. Without an
     * `error` listener the hook stayed `computing` forever and the dialog
     * spun above a live Apply button, with nothing in the log.
     */
    it("says so when the worker itself dies, rather than waiting on it", async () => {
      render(
        <Probe
          original={big(SYNC_LINES, "")}
          modified={big(SYNC_LINES, "\nextra")}
        />
      );
      expect(screen.getByTestId("state")).toHaveTextContent("computing");
      const worker = FakeWorker.instances[0];
      await act(async () => worker.breaks());
      expect(screen.getByTestId("state")).toHaveTextContent("failed");
    });

    /** The diff itself throwing is the same: an answer, and a bad one. */
    it("says so when the diff could not be computed", async () => {
      render(
        <Probe
          original={big(SYNC_LINES, "")}
          modified={big(SYNC_LINES, "\nextra")}
        />
      );
      // A worker that died was discarded, so the live one is the last made.
      const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
      await act(async () => worker.fails());
      expect(screen.getByTestId("state")).toHaveTextContent("failed");
    });

    /**
     * The threshold is the PR's own claim, and it was reachable only through
     * the other disjunct: with no `Worker` at all everything is synchronous,
     * so the small-pair test passed with the threshold deleted.
     */
    it("keeps a small pair off the worker even where a worker exists", () => {
      render(<Probe original={"a\nb"} modified={"a\nc"} />);
      expect(screen.getByTestId("state")).toHaveTextContent("2 changed");
      const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
      expect(worker?.pending ?? []).toHaveLength(0);
    });
  });
});
