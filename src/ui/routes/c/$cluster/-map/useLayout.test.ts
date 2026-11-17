import { describe, expect, it } from "vite-plus/test";

import type { GraphEdge, GraphGroup, GraphNode } from "./types";
import { askFor } from "./useLayout";

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
