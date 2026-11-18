// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { LayoutAnswer, LayoutRequest } from "@/lib/map-layout";
import type { GraphEdge, GraphGroup, GraphNode } from "./types";
import { askFor, packingKey, useLayout } from "./useLayout";

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
                    routes: each.nodes ? {} : undefined,
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
          routes: {},
        },
      ],
    ]);
    const packed = packingKey([["shop", 500, 120]], []);
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
    // Another edge between the same two nodes has no route laid out yet.
    expect(
      askFor(
        [group],
        [node("svc"), node("web")],
        [{ ...edge, id: "e2" }],
        cache,
        packed
      )
    ).not.toBeNull();
  });

  /**
   * Cards were packed without regard to the edges between them. Fails if an
   * edge between two groups is not handed as a link the way it lays out, if
   * a joined group is handed as a size while one alone is, or if nothing
   * changed and the same layout is asked again for ever.
   */
  it("hands the edges between groups as links, and the groups they join whole", () => {
    const shop = { ...group, id: "shop" };
    const infra = { ...group, id: "infra" };
    const quiet = { ...group, id: "quiet" };
    const nodes = [
      { ...node("web"), group: "shop" },
      { ...node("gw"), group: "infra" },
      { ...node("alone"), group: "quiet" },
    ];
    const attach: GraphEdge = {
      id: "web>gw",
      from: "web",
      to: "gw",
      tone: "ok",
      reversed: true,
    };
    const first = askFor(
      [shop, infra, quiet],
      nodes,
      [attach],
      new Map(),
      null
    )!;
    expect(first.request.links).toEqual([
      {
        id: "web>gw",
        from: "gw",
        to: "web",
        fromGroup: "infra",
        toGroup: "shop",
      },
    ]);

    const laid = (id: string) => ({
      signature: first.signatures.get(id)!,
      width: 240,
      height: 102,
      positions: {},
      routes: {},
    });
    const cache = new Map(
      ["shop", "infra", "quiet"].map((id) => [id, laid(id)])
    );
    const packed = packingKey(
      [
        ["shop", 240, 102],
        ["infra", 240, 102],
        ["quiet", 240, 102],
      ],
      first.request.links!
    );
    expect(
      askFor([shop, infra, quiet], nodes, [attach], cache, packed)
    ).toBeNull();
    // Another edge between the same two groups' nodes is routed anew.
    expect(
      askFor(
        [shop, infra, quiet],
        nodes,
        [{ ...attach, id: "web>gw:2" }],
        cache,
        packed
      )
    ).not.toBeNull();

    const moved = askFor(
      [shop, infra, quiet],
      [...nodes, { ...node("api"), group: "quiet" }],
      [attach],
      cache,
      packed
    )!;
    const asked = new Map(moved.request.groups.map((each) => [each.id, each]));
    expect(asked.get("shop")?.nodes).toBeDefined();
    expect(asked.get("infra")?.nodes).toBeDefined();
    expect(asked.get("quiet")?.nodes?.map((each) => each.id)).toEqual([
      "alone",
      "api",
    ]);
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
   * A node that moved out of a group that was then collapsed took the place
   * it last had in that group, over the one its new group gave it. Fails if
   * a collapsed group's last layout places any node.
   */
  it("places a node where its new group put it, not where a collapsed group last had it", async () => {
    asked.length = 0;
    const shop = (collapsed: boolean): GraphGroup => ({ ...group, collapsed });
    const cart: GraphGroup = { ...group, id: "cart", label: "cart" };
    const moved = { ...node("web"), group: "cart" };
    const { result, rerender } = renderHook(
      ({ groups, nodes }) => useLayout(groups, nodes, []),
      {
        initialProps: {
          groups: [cart, shop(false)],
          nodes: [
            node("svc"),
            node("api"),
            node("web"),
            { ...node("db"), group: "cart" },
          ],
        },
      }
    );
    await waitFor(() => expect(asked).toHaveLength(1), SLOW);
    await act(async () => asked[0].answer());
    expect(result.current.nodes.get("web")).toEqual({ x: 0, y: 100 });

    rerender({
      groups: [cart, shop(true)],
      nodes: [
        node("svc"),
        node("api"),
        moved,
        { ...node("db"), group: "cart" },
      ],
    });
    await waitFor(() => expect(asked).toHaveLength(2), SLOW);
    await act(async () => asked[1].answer());
    const cartAsk = asked[1].request.groups.find((each) => each.id === "cart");
    expect(cartAsk?.nodes?.map((each) => each.id)).toEqual(["web", "db"]);
    expect(result.current.nodes.get("web")).toEqual({ x: 0, y: 0 });
    expect(result.current.nodes.has("svc")).toBe(false);
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
