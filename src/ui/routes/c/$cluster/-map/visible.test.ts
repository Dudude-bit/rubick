import { describe, expect, it } from "vite-plus/test";

import { cardId, visibleGraph } from "./visible";
import type { GraphEdge, GraphGroup, GraphNode } from "./types";

const group = (id: string, collapsed: boolean): GraphGroup => ({
  id,
  label: id,
  collapsed,
  tone: "ok",
  summary: null,
});
const node = (id: string, groupId: string | null): GraphNode => ({
  id,
  group: groupId,
  kind: "Deployment",
  label: id,
  tone: "ok",
});
const edge = (
  from: string,
  to: string,
  tone: GraphEdge["tone"] = "ok"
): GraphEdge => ({ id: `${from}>${to}`, from, to, tone });

describe("what a canvas draws with groups collapsed", () => {
  /** A route into a collapsed namespace must still be seen to lead somewhere: dropped, the map says nothing reaches it. */
  it("draws an edge into a collapsed group to its card", () => {
    const drawn = visibleGraph(
      [group("edge", false), group("shop", true)],
      [node("route", "edge"), node("svc", "shop"), node("web", "shop")],
      [edge("route", "svc"), edge("svc", "web")]
    );
    expect(drawn.nodes.map((n) => n.id)).toEqual(["route"]);
    expect(drawn.edges.map((e) => [e.from, e.to])).toEqual([
      ["route", cardId("shop")],
    ]);
  });

  /** Two edges folded into one pair keep the louder tone: a broken path behind a healthy one must not turn the line green. */
  it("folds edges to one card into one, at the loudest tone", () => {
    const drawn = visibleGraph(
      [group("edge", false), group("shop", true)],
      [node("route", "edge"), node("a", "shop"), node("b", "shop")],
      [edge("route", "a", "ok"), edge("route", "b", "err")]
    );
    expect(drawn.edges).toHaveLength(1);
    expect(drawn.edges[0].tone).toBe("err");
  });

  /** A node outside every group, an address outside the cluster, is always drawn. */
  it("draws a node in no group whatever is collapsed", () => {
    const drawn = visibleGraph(
      [group("shop", true)],
      [node("outside", null), node("web", "shop")],
      [edge("web", "outside")]
    );
    expect(drawn.nodes.map((n) => n.id)).toEqual(["outside"]);
    expect(drawn.edges[0].from).toBe(cardId("shop"));
  });
});
