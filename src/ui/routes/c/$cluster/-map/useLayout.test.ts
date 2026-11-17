// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { LayoutAnswer, LayoutRequest } from "@/lib/map-layout";
import type { GraphEdge, GraphGroup, GraphNode } from "./types";
import { askFor, useLayout } from "./useLayout";

// ELK is loaded and run for real: under a loaded machine that alone outlasts
// the default five seconds the waits below were written around.
vi.setConfig({ testTimeout: 20_000 });

/** Every layout asked, each waiting for the test to answer it. */
const asked = vi.hoisted(
  () => [] as { request: LayoutRequest; answer: (failed?: string) => void }[]
);
vi.mock("@/lib/map-layout", async (original) => ({
  ...(await original<typeof import("@/lib/map-layout")>()),
  layOut: (_elk: unknown, request: LayoutRequest) =>
    new Promise<LayoutAnswer>((resolve) =>
      asked.push({
        request,
        answer: (failed) =>
          resolve(
            failed
              ? { id: request.id, groups: [], ms: 0, failed }
              : {
                  id: request.id,
                  ms: 1,
                  groups: request.groups.map((each, index) => ({
                    id: each.id,
                    x: 0,
                    y: index * 100,
                    width: 200,
                    height: 100,
                    positions: each.nodes
                      ? Object.fromEntries(
                          each.nodes.map((node, at) => [
                            node.id,
                            { x: 0, y: at * 50 },
                          ])
                        )
                      : undefined,
                  })),
                }
          ),
      })
    ),
}));

const group: GraphGroup = {
  id: "shop",
  label: "shop",
  collapsed: false,
  tone: "ok",
  summary: null,
};
const node = (id: string, tone: GraphNode["tone"] = "ok"): GraphNode => ({
  id,
  group: "shop",
  kind: "Deployment",
  label: id,
  tone,
});
const edge: GraphEdge = { id: "e", from: "svc", to: "web", tone: "ok" };

describe("what the layout worker is asked", () => {
  /** A changed colour must not move anything: asking the worker again would reflow a group because one pod restarted. */
  it("asks nothing when only a tone changed", () => {
    const first = askFor(
      [group],
      [node("svc"), node("web")],
      [edge],
      new Map(),
      null
    );
    expect(first).not.toBeNull();
    const cache = new Map([
      [
        "shop",
        {
          signature: first!.signatures.get("shop")!,
          width: 500,
          height: 120,
          positions: { svc: { x: 16, y: 40 }, web: { x: 280, y: 40 } },
        },
      ],
    ]);
    const packed = JSON.stringify([["shop", 500, 120]]);
    expect(
      askFor([group], [node("svc", "err"), node("web")], [edge], cache, packed)
    ).toBeNull();
    const grown = askFor(
      [group],
      [node("svc"), node("web"), node("new")],
      [edge],
      cache,
      packed
    );
    expect(grown?.request.groups[0].previous).toEqual(
      cache.get("shop")!.positions
    );
  });

  /** A collapsed group is packed as its card and nothing inside it is laid out. */
  it("packs a collapsed group by its card alone", () => {
    const ask = askFor(
      [{ ...group, collapsed: true }],
      [],
      [],
      new Map(),
      null
    );
    expect(ask?.request.groups).toEqual([
      { id: "shop", size: { width: 248, height: 116 } },
    ]);
  });
});

describe("laying out a canvas that keeps changing", () => {
  const SLOW = { timeout: 15_000 };
  const laidOut = (nodes: GraphNode[]) =>
    renderHook(({ nodes }) => useLayout([group], nodes, []), {
      initialProps: { nodes },
    });

  /**
   * On a scope that took longer to lay out than it took to change, every
   * render dropped the answer in flight and queued the same layout again, so
   * nothing was ever placed and the worker's queue grew. Fails if a render
   * asks again while one is in flight, or an answer is dropped.
   */
  it("asks one layout at a time and lays out what changed while it ran once it is back", async () => {
    asked.length = 0;
    const { result, rerender } = laidOut([node("svc")]);
    await waitFor(() => expect(asked).toHaveLength(1), SLOW);
    rerender({ nodes: [node("svc")] });
    rerender({ nodes: [node("svc")] });
    rerender({ nodes: [node("svc"), node("web")] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(1);

    await act(async () => asked[0].answer());
    expect(result.current.nodes.has("svc")).toBe(true);
    expect(result.current.settled).toBe(false);
    await waitFor(() => expect(asked).toHaveLength(2), SLOW);
    expect(asked[1].request.groups[0].nodes?.map((each) => each.id)).toEqual([
      "svc",
      "web",
    ]);
    await act(async () => asked[1].answer());
    expect(result.current.nodes.has("web")).toBe(true);
    expect(result.current.settled).toBe(true);
    expect(asked).toHaveLength(2);
  });

  /**
   * A layout that failed left the canvas blank and was asked again on every
   * render. Fails if the failure is not kept for the canvas to say, if the
   * same request is asked again, or if a change after it is not asked.
   */
  it("keeps a failed layout's words and asks again only once the canvas changes", async () => {
    asked.length = 0;
    const { result, rerender } = laidOut([node("svc")]);
    await waitFor(() => expect(asked).toHaveLength(1), SLOW);
    await act(async () => asked[0].answer("elk could not place it"));
    expect(result.current.failed).toBe("elk could not place it");
    rerender({ nodes: [node("svc")] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toHaveLength(1);
    rerender({ nodes: [node("svc"), node("web")] });
    await waitFor(() => expect(asked).toHaveLength(2), SLOW);
    await act(async () => asked[1].answer());
    expect(result.current.failed).toBeNull();
  });
});
