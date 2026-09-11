import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { computeLineDiff, SYNC_LINES } from "@/lib/line-diff";
import { useLineDiff } from "./useLineDiff";

function Probe({ original, modified }: { original: string; modified: string }) {
  const { lines, computing } = useLineDiff(original, modified);
  return (
    <span data-testid="state">
      {computing
        ? "computing"
        : `${lines.filter((l) => l.type !== "unchanged").length} changed`}
    </span>
  );
}

/** A Worker that answers like the real one, but on this thread and only when told. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners: Array<(event: MessageEvent) => void> = [];
  pending: Array<{ id: number; original: string; modified: string }> = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  addEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  postMessage(request: { id: number; original: string; modified: string }) {
    this.pending.push(request);
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
  });
});
