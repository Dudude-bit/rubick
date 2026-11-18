import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vite-plus/test";

import { layOut, type LayoutGroupAsk } from "./map-layout";

const elk = new ELK();
const box = (id: string) => ({ id, width: 200, height: 44 });

const shop: LayoutGroupAsk = {
  id: "shop",
  nodes: [box("ing"), box("svc"), box("web"), box("cfg")],
  edges: [
    { id: "a", from: "ing", to: "svc" },
    { id: "b", from: "svc", to: "web" },
    { id: "c", from: "web", to: "cfg" },
  ],
};

describe("laying out a map", () => {
  /** Two readers of one cluster must see one picture, and a redraw of the same structure must not move anything. */
  it("places the same groups the same way every time", async () => {
    const one = await layOut(elk, { id: 1, groups: [shop] });
    const two = await layOut(elk, { id: 2, groups: [shop] });
    expect(two.groups).toEqual(one.groups);
  });

  /** The chain reads left to right: route, Service, workload, what it uses. */
  it("lays a group's chain out left to right", async () => {
    const { groups } = await layOut(elk, { id: 1, groups: [shop] });
    const at = groups[0].positions!;
    expect(at.ing.x).toBeLessThan(at.svc.x);
    expect(at.svc.x).toBeLessThan(at.web.x);
    expect(at.web.x).toBeLessThan(at.cfg.x);
  });

  /** An edge to a node in another group names a node ELK was not given, which it refuses outright; the whole map would fail to draw. */
  it("leaves out an edge to a node outside the group rather than failing", async () => {
    const answer = await layOut(elk, {
      id: 1,
      groups: [
        {
          ...shop,
          edges: [...shop.edges!, { id: "x", from: "web", to: "elsewhere" }],
        },
      ],
    });
    expect(answer.failed).toBeUndefined();
    expect(Object.keys(answer.groups[0].positions!)).toHaveLength(4);
  });

  /** A group held as it was is packed by its size and not laid out again: its nodes keep the places the map already has for them. */
  it("packs a held group by its size and says nothing of its nodes", async () => {
    const { groups } = await layOut(elk, {
      id: 1,
      groups: [shop, { id: "billing", size: { width: 240, height: 96 } }],
    });
    const billing = groups.find((group) => group.id === "billing")!;
    expect(billing.positions).toBeUndefined();
    expect([billing.width, billing.height]).toEqual([240, 96]);
  });

  /** A Deployment added beside two others must not reorder them: the reader's eye is on where they were. */
  it("keeps the order of the nodes that stayed when one is added", async () => {
    const wide: LayoutGroupAsk = {
      id: "shop",
      nodes: [box("svc"), box("a"), box("b")],
      edges: [
        { id: "1", from: "svc", to: "a" },
        { id: "2", from: "svc", to: "b" },
      ],
    };
    const first = (await layOut(elk, { id: 1, groups: [wide] })).groups[0]
      .positions!;
    const again = (
      await layOut(elk, {
        id: 2,
        groups: [
          {
            ...wide,
            nodes: [box("svc"), box("new"), box("a"), box("b")],
            edges: [...wide.edges!, { id: "3", from: "svc", to: "new" }],
            previous: first,
          },
        ],
      })
    ).groups[0].positions!;
    expect(Math.sign(again.a.y - again.b.y)).toBe(
      Math.sign(first.a.y - first.b.y)
    );
  });

  /**
   * On Traffic, loadgen's card was packed right of the gateway's, and its
   * edge ran right to left through both nodes; the gateway's edge into
   * bookinfo climbed across the bookinfo card. Fails if a caller's group is
   * not laid out before its callee's, if an edge between groups is not
   * routed, if a route passes through a node it does not join, or if a
   * group no edge joins is not packed after the joined ones.
   */
  it("lays out joined groups caller before callee and routes their edges around every node", async () => {
    const group = (
      id: string,
      nodes: string[],
      edges: [string, string][] = []
    ) => ({
      id,
      nodes: nodes.map(box),
      edges: edges.map(([from, to]) => ({ id: `${from}>${to}`, from, to })),
    });
    const answer = await layOut(elk, {
      id: 1,
      groups: [
        group(
          "bookinfo",
          ["pp", "det", "rev", "rat"],
          [
            ["pp", "det"],
            ["pp", "rev"],
            ["rev", "rat"],
          ]
        ),
        group("istio", ["gw"]),
        group("loadgen", ["lg"]),
        group("quiet", ["alone"]),
      ],
      links: [
        {
          id: "lg>gw",
          from: "lg",
          to: "gw",
          fromGroup: "loadgen",
          toGroup: "istio",
        },
        {
          id: "gw>pp",
          from: "gw",
          to: "pp",
          fromGroup: "istio",
          toGroup: "bookinfo",
        },
      ],
    });
    const at = new Map(answer.groups.map((each) => [each.id, each]));
    expect(at.get("loadgen")!.x).toBeLessThan(at.get("istio")!.x);
    expect(at.get("istio")!.x).toBeLessThan(at.get("bookinfo")!.x);
    const joinedBottom = Math.max(
      ...["loadgen", "istio", "bookinfo"].map(
        (id) => at.get(id)!.y + at.get(id)!.height
      )
    );
    expect(at.get("quiet")!.y).toBeGreaterThanOrEqual(joinedBottom);

    // Every node's box on the map, to check no route runs through one.
    const boxes = [...at.values()].flatMap((each) =>
      Object.entries(each.positions ?? {}).map(([id, point]) => ({
        id,
        x: each.x + point.x,
        y: each.y + point.y,
        width: 200,
        height: 44,
      }))
    );
    const routes = answer.routes ?? {};
    for (const id of ["lg>gw", "gw>pp", "pp>det", "pp>rev", "rev>rat"]) {
      const points = routes[id];
      expect(points, id).toBeDefined();
      const [from, to] = id.split(">");
      for (const node of boxes.filter(
        (each) => each.id !== from && each.id !== to
      ))
        for (const [a, b] of points
          .slice(1)
          .map((point, step) => [points[step], point]))
          expect(crosses(a, b, node), `${id} crosses ${node.id}`).toBe(false);
    }
  });
});

/** Whether the straight segment a–b runs through the inside of a box. */
function crosses(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number }
): boolean {
  const steps = 50;
  for (let step = 0; step <= steps; step++) {
    const x = a.x + ((b.x - a.x) * step) / steps;
    const y = a.y + ((b.y - a.y) * step) / steps;
    if (
      x > box.x + 1 &&
      x < box.x + box.width - 1 &&
      y > box.y + 1 &&
      y < box.y + box.height - 1
    )
      return true;
  }
  return false;
}
