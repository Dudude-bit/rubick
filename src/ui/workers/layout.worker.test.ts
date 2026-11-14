/**
 * Nothing executes the worker module but a browser: the only references to
 * it are an erased `import type` and a URL. This runs its real handler.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ElkNode } from "elkjs/lib/elk-api";

import type { LayoutAnswer, LayoutRequest } from "./layout.worker";

const posted: LayoutAnswer[] = [];
const elk = vi.hoisted(() => ({ refuse: false }));

vi.mock("elkjs/lib/elk.bundled.js", async (original) => {
  const { default: Real } =
    await original<typeof import("elkjs/lib/elk.bundled.js")>();
  return {
    default: class {
      private real = new Real();
      layout(graph: ElkNode) {
        return elk.refuse
          ? Promise.reject(new Error("JsonImportException: no such node"))
          : this.real.layout(graph);
      }
    },
  };
});

beforeEach(async () => {
  posted.length = 0;
  elk.refuse = false;
  vi.resetModules();
  vi.stubGlobal("self", {
    onmessage: null as ((event: MessageEvent<LayoutRequest>) => void) | null,
    postMessage: (answer: LayoutAnswer) => posted.push(answer),
  });
  await import("./layout.worker");
});

async function ask(request: LayoutRequest): Promise<LayoutAnswer> {
  (
    globalThis as unknown as { self: { onmessage: (e: unknown) => void } }
  ).self.onmessage({ data: request } as MessageEvent<LayoutRequest>);
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  return posted[0];
}

describe("the layout worker", () => {
  /** Fails if the handler computes a layout and never posts it: the map would wait on it for good. */
  it("answers a request with its id and a place for every group", async () => {
    const answer = await ask({
      id: 7,
      groups: [{ id: "shop", size: { width: 240, height: 96 } }],
    });
    expect(answer.id).toBe(7);
    expect(answer.groups.map((group) => group.id)).toEqual(["shop"]);
  });

  /** A layout ELK refuses still answers, named failed: silence and still-working look the same to the map. */
  it("answers a request it cannot lay out as failed", async () => {
    elk.refuse = true;
    const answer = await ask({
      id: 8,
      groups: [{ id: "shop", size: { width: 240, height: 96 } }],
    });
    expect(answer.id).toBe(8);
    expect(answer.failed).toBe("JsonImportException: no such node");
  });
});
