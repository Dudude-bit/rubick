/**
 * The worker module was executed by nothing: the only references to it are
 * an erased `import type` and a URL string, so a handler that computed the
 * answer and then never posted it passed tsc and the whole suite, and the
 * dialog would have spun forever. This runs the real handler.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DiffAnswer, DiffRequest } from "./diff.worker";

const posted: DiffAnswer[] = [];

beforeEach(async () => {
  posted.length = 0;
  vi.resetModules();
  vi.stubGlobal("self", {
    onmessage: null as ((event: MessageEvent<DiffRequest>) => void) | null,
    postMessage: (answer: DiffAnswer) => posted.push(answer),
  });
  await import("./diff.worker");
});

function ask(request: DiffRequest) {
  (globalThis as unknown as { self: { onmessage: (e: unknown) => void } }).self
    .onmessage({ data: request } as MessageEvent<DiffRequest>);
}

describe("the diff worker", () => {
  it("answers the question it was asked, carrying its id back", () => {
    ask({ id: 7, original: "a\nb", modified: "a\nc" });
    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe(7);
    expect(posted[0].lines.filter((l) => l.type !== "unchanged")).toHaveLength(
      2
    );
  });

  it("answers even when it cannot compute, so nobody waits on silence", () => {
    ask({ id: 9 } as unknown as DiffRequest);
    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe(9);
    expect(posted[0].failed).toBeTruthy();
  });
});
