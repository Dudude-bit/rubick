/**
 * The viewer consulted `computing` only when it had nothing at all to draw.
 * With a previous answer in hand it fell through and decided from it — so a
 * buffer the reader had just rewritten was drawn with a green "No changes
 * detected" until the worker came back, above a live Apply button. That is
 * the third state collapsing into the second, in the one dialog where it
 * costs something.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { computeLineDiff, SYNC_LINES } from "@/lib/line-diff";
import { SETTLE_MS } from "@/hooks/useLineDiff";
import { YamlDiffViewer } from "./YamlDiffViewer";

class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners: Array<(event: MessageEvent) => void> = [];
  pending: Array<{ id: number; original: string; modified: string }> = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  terminate() {}
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

/** The buffer stands still, which is when the worker is asked. */
async function settles() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", FakeWorker);
  for (const instance of FakeWorker.instances) instance.pending = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("what the diff viewer says while a newer answer is on its way", () => {
  it("does not call a changed buffer unchanged because the old answer was", async () => {
    const same = big(SYNC_LINES, "");
    const { rerender } = render(
      <YamlDiffViewer original={same} modified={same} />
    );
    await settles();
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    await act(async () => worker.answer());
    expect(screen.getByText(/no changes/i)).toBeInTheDocument();

    // Every line rewritten; the answer for it has not arrived yet.
    rerender(
      <YamlDiffViewer
        original={same}
        modified={big(SYNC_LINES, "").replace(/line/g, "changed")}
      />
    );
    expect(screen.queryByText(/no changes/i)).toBeNull();
  });
});
