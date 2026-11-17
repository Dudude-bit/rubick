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
});
