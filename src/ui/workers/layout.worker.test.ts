/**
 * Nothing executes the worker module but a browser: the only references to
 * it are an erased `import type` and a URL. This runs its real handler.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ElkNode } from "elkjs/lib/elk-api";

import type { LayoutAnswer, LayoutRequest } from "./layout.worker";

const posted: LayoutAnswer[] = [];
const elk = vi.hoisted(() => ({ refuse: false, calls: 0 }));

vi.mock("elkjs/lib/elk.bundled.js", async (original) => {
  const { default: Real } =
    await original<typeof import("elkjs/lib/elk.bundled.js")>();
  return {
    default: class {
      private real = new Real();
      layout(graph: ElkNode) {
        elk.calls += 1;
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
  elk.calls = 0;
  vi.resetModules();
  vi.stubGlobal("self", {
    onmessage: null as ((event: MessageEvent<LayoutRequest>) => void) | null,
    postMessage: (answer: LayoutAnswer) => posted.push(answer),
  });
  await import("./layout.worker");
});

function send(data: unknown) {
  (
    globalThis as unknown as { self: { onmessage: (e: unknown) => void } }
  ).self.onmessage({ data } as MessageEvent<unknown>);
}

async function ask(request: LayoutRequest): Promise<LayoutAnswer> {
  send(request);
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

  /**
   * The worker laid out whatever it was handed: a message that was not a
   * layout request went into ELK as one. Fails if a malformed message
   * reaches ELK, if one with an id is not answered as failed, or if one
   * with no id is answered at all.
   */
  it("refuses a message that is not a layout request before laying anything out", async () => {
    send({ id: 9, groups: [{ id: "shop", nodes: [{ id: "web" }] }] });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      id: 9,
      groups: [],
      failed: expect.any(String),
    });
    send({ id: 10, groups: [], links: [{ id: "a", from: "x" }] });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ id: 10, failed: expect.any(String) });
    send("lay this out");
    send({ groups: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toHaveLength(2);
    expect(elk.calls).toBe(0);
  });
});
