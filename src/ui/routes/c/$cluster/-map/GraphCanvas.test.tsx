import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GraphCanvas } from "./GraphCanvas";
import type { GraphGroup, GraphNode } from "./types";

// ELK is loaded and run for real: under a loaded machine that alone outlasts
// the default five seconds the waits below were written around.
vi.setConfig({ testTimeout: 20_000 });

let placed = 0;
/** What GraphCanvas handed React Flow last. */
interface Handed {
  nodes: { id: string; type: string; data: unknown }[];
  edges: {
    id: string;
    source: string;
    target: string;
    data?: { route?: unknown[] };
  }[];
  nodeTypes: Record<string, (props: { id: string; data: unknown }) => unknown>;
  onMoveStart: (event: unknown) => void;
}
let handed: Handed = {
  nodes: [],
  edges: [],
  nodeTypes: {},
  onMoveStart: () => {},
};
/** The canvas's size as React Flow's store holds it. */
const view = vi.hoisted(() => ({
  width: 800,
  height: 600,
  transform: [0, 0, 1] as [number, number, number],
}));
const setViewport = vi.fn(async () => true);
const setCenter = vi.fn(async () => true);
/** How many nodes were placed each time the view was fitted. */
const fits: number[] = [];
const fitView = vi.fn(async () => {
  fits.push(placed);
  return true;
});

vi.mock("@/lib/map-layout", async (original) => {
  const real = await original<typeof import("@/lib/map-layout")>();
  return {
    ...real,
    layOut: (...args: Parameters<typeof real.layOut>) =>
      args[1].groups.some((group) => group.id === "broken")
        ? Promise.reject(new Error("elk gave up"))
        : real.layOut(...args),
  };
});

vi.mock("@xyflow/react", async (original) => {
  const { createElement } = await import("react");
  return {
    ...(await original<typeof import("@xyflow/react")>()),
    // Draws the object nodes it is handed, so a test can click one.
    ReactFlow: (props: typeof handed) => {
      placed = props.nodes.length;
      handed = props;
      return props.nodes
        .filter((each) => each.type === "object")
        .map((each) =>
          createElement(props.nodeTypes.object as never, {
            key: each.id,
            id: each.id,
            data: each.data,
          })
        );
    },
    Background: () => null,
    Handle: () => null,
    useReactFlow: () => ({
      fitView,
      setViewport,
      setCenter,
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      getZoom: () => 1,
    }),
    useStore: (select: (state: typeof view) => unknown) => select(view),
    useStoreApi: () => ({ getState: () => view }),
  };
});

const group = (id: string): GraphGroup => ({
  id,
  label: id,
  collapsed: false,
  tone: "ok",
  summary: null,
});
const node = (id: string, home: string): GraphNode => ({
  id,
  group: home,
  kind: "Deployment",
  label: id,
  tone: "ok",
});

function canvas(groups: string[], fitKey?: string | null) {
  return (
    <GraphCanvas
      groups={groups.map(group)}
      nodes={groups.map((id) => node(`${id}/web`, id))}
      edges={[]}
      onToggleGroup={() => {}}
      onOpen={() => {}}
      fitKey={fitKey}
      ariaLabel="map"
    />
  );
}

/** The layout loads elkjs on its first call, which takes a while under load. */
const SLOW = { timeout: 15_000 };

/** Waits until `groups` groups, each a frame and one node, are placed. */
const laidOut = (groups: number) =>
  waitFor(() => expect(placed).toBe(groups * 2), SLOW);

describe("the map's view", () => {
  /**
   * The map opened zoomed in on the first card the stream drew, and in Live
   * mode on a corner of the first few nodes, because nothing fitted again as
   * the rest arrived. Fails if the view is fitted before a layout is laid
   * out, is not fitted again as nodes arrive while the reader has not moved
   * it, is fitted over a view the reader moved, or is not fitted again for
   * a new key.
   */
  it("stays fitted as nodes arrive until the reader moves the view, and again for a new key", async () => {
    fitView.mockClear();
    fits.length = 0;
    const { rerender } = render(canvas(["argo"], "namespace"));
    await waitFor(() => expect(fits).toEqual([2]), SLOW);

    rerender(canvas(["argo", "billing"], "namespace"));
    await waitFor(() => expect(fits).toEqual([2, 4]), SLOW);

    handed.onMoveStart({} as MouseEvent);
    rerender(canvas(["argo", "billing", "shop"], "namespace"));
    await laidOut(3);
    expect(fits).toEqual([2, 4]);

    rerender(canvas(["argo", "billing", "shop"], "namespace\u0000whole"));
    await waitFor(() => expect(fits).toEqual([2, 4, 6]), SLOW);
    rerender(
      canvas(["argo", "billing", "shop", "zoo"], "namespace\u0000whole")
    );
    await waitFor(() => expect(fits).toEqual([2, 4, 6, 8]), SLOW);
  });

  /**
   * A peek opened from the map narrowed the canvas and left it on empty
   * space. Fails if a resize does not fit a view the reader has not moved,
   * does not bring the node they last opened back into a view they moved,
   * or moves a view they moved other than by keeping its middle.
   */
  it("keeps the right view when the canvas changes size", async () => {
    Object.assign(view, { width: 800, height: 600 });
    fitView.mockClear();
    setViewport.mockClear();
    setCenter.mockClear();
    const opened = vi.fn();
    const draw = () => (
      <GraphCanvas
        groups={[group("shop")]}
        nodes={[node("web", "shop")]}
        edges={[]}
        onToggleGroup={() => {}}
        onOpen={opened}
        ariaLabel="map"
      />
    );
    const { rerender } = render(draw());
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1), SLOW);

    Object.assign(view, { width: 500 });
    rerender(draw());
    expect(fitView).toHaveBeenCalledTimes(2);

    handed.onMoveStart({} as MouseEvent);
    Object.assign(view, { width: 800 });
    rerender(draw());
    expect(setViewport).toHaveBeenCalledWith({ x: 150, y: 0, zoom: 1 });
    expect(fitView).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /web/ }), {
      detail: 1,
    });
    fireEvent.doubleClick(screen.getByRole("button", { name: /web/ }));
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ id: "web" }),
      "page"
    );
    Object.assign(view, { width: 10 });
    rerender(draw());
    expect(setCenter).toHaveBeenCalledTimes(1);
  });

  /**
   * Picking the search result the view was last taken to, after moving the
   * view away, did nothing: the pick was the same id, so nothing changed.
   * Fails if a new pick of the same node does not pan to it again, or if
   * the same pick pans again on a redraw.
   */
  it("pans to a node each time it is picked", async () => {
    setCenter.mockClear();
    const draw = (focus: { id: string }) => (
      <GraphCanvas
        groups={[group("shop")]}
        nodes={[node("web", "shop")]}
        edges={[]}
        onToggleGroup={() => {}}
        onOpen={() => {}}
        focus={focus}
        ariaLabel="map"
      />
    );
    const pick = { id: "web" };
    const { rerender } = render(draw(pick));
    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(1), SLOW);
    rerender(draw(pick));
    expect(setCenter).toHaveBeenCalledTimes(1);
    rerender(draw({ id: "web" }));
    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(2), SLOW);
  });

  /**
   * A layout that failed under a new key must not leave the next good one
   * under that key unfitted. Fails if the view is not fitted to the layout
   * that comes after the failure.
   */
  it("fits the layout that recovers from a failed one under the same key", async () => {
    fits.length = 0;
    const { rerender } = render(canvas(["argo"], "a"));
    await waitFor(() => expect(fits).toEqual([2]), SLOW);
    rerender(canvas(["argo", "broken"], "b"));
    await screen.findByRole("alert", undefined, SLOW);
    rerender(canvas(["argo", "billing"], "b"));
    await waitFor(() => expect(fits.at(-1)).toBe(4), SLOW);
  });

  /**
   * A search pick in a closed group opened it, centred the node, and the
   * new layout of the opened group fitted the whole map over it. Fails if
   * a layout after a pick is fitted over the node the pick centred.
   */
  it("keeps the node a pick centred rather than fitting the layout it opened", async () => {
    fits.length = 0;
    setCenter.mockClear();
    const draw = (shown: string[], focus: { id: string } | null) => (
      <GraphCanvas
        groups={shown.map(group)}
        nodes={shown.map((id) => node(`${id}/web`, id))}
        edges={[]}
        onToggleGroup={() => {}}
        onOpen={() => {}}
        focus={focus}
        fitKey="namespace"
        ariaLabel="map"
      />
    );
    const { rerender } = render(draw(["argo"], null));
    await waitFor(() => expect(fits).toEqual([2]), SLOW);
    rerender(draw(["argo", "billing"], { id: "billing/web" }));
    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(1), SLOW);
    expect(fits).toEqual([2]);
  });

  /**
   * A canvas hidden and shown again at the size it had moved a moved view
   * by half that size: the hidden 0×0 was kept as the size before. Fails if
   * a view comes back moved by a size that did not change.
   */
  it("keeps a moved view where it was when the canvas is hidden and shown again", async () => {
    Object.assign(view, { width: 800, height: 600 });
    setViewport.mockClear();
    fitView.mockClear();
    const draw = () => (
      <GraphCanvas
        groups={[group("shop")]}
        nodes={[node("web", "shop")]}
        edges={[]}
        onToggleGroup={() => {}}
        onOpen={() => {}}
        ariaLabel="map"
      />
    );
    const { rerender } = render(draw());
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1), SLOW);
    handed.onMoveStart({} as MouseEvent);
    Object.assign(view, { width: 0, height: 0 });
    rerender(draw());
    Object.assign(view, { width: 800, height: 600 });
    rerender(draw());
    expect(setViewport).not.toHaveBeenCalled();
  });

  /**
   * A double click slower than the peek's wait opened the peek, which moved
   * the map, and the second click landed on empty canvas: the page never
   * opened. Fails if a double click does not open the page of the node its
   * first click landed on, wherever and however slowly its second lands, or
   * if a click elsewhere in between does not let that node go.
   */
  it("opens the page of the node a double click began on, wherever its second click lands", async () => {
    const opened = vi.fn();
    const draw = () => (
      <GraphCanvas
        groups={[group("shop")]}
        nodes={[node("web", "shop")]}
        edges={[]}
        onToggleGroup={() => {}}
        onOpen={opened}
        ariaLabel="map"
      />
    );
    render(draw());
    const card = await screen.findByRole("button", { name: /web/ }, SLOW);
    const canvas = screen.getByRole("group", { name: "map" });

    fireEvent.click(card, { detail: 1 });
    await waitFor(() =>
      expect(opened).toHaveBeenCalledWith(
        expect.objectContaining({ id: "web" }),
        "peek"
      )
    );
    fireEvent.click(canvas, { detail: 2 });
    fireEvent.doubleClick(canvas);
    expect(opened).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "web" }),
      "page"
    );

    opened.mockClear();
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(canvas, { detail: 1 });
    fireEvent.doubleClick(canvas);
    expect(opened).not.toHaveBeenCalledWith(expect.anything(), "page");
  });

  /** A `null` key holds the fit until the page says the drawing is worth fitting. */
  it("holds the fit while its key is null", async () => {
    fitView.mockClear();
    const { rerender } = render(canvas(["argo"], null));
    await laidOut(1);
    expect(fitView).not.toHaveBeenCalled();
    rerender(canvas(["argo"], "whole"));
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1), SLOW);
  });

  /**
   * Every batch and every answer handed React Flow a new object for each
   * node, frame and edge, and React Flow redrew the whole map for each.
   * Fails if what did not change is handed anew, or what changed is not.
   */
  it("hands React Flow the objects it had for whatever did not change", async () => {
    const shop = group("shop");
    const web = node("web", "shop");
    const db = node("db", "shop");
    const wire = { id: "web>db", from: "web", to: "db", tone: "ok" as const };
    const draw = (nodes: GraphNode[]) => (
      <GraphCanvas
        groups={[shop]}
        nodes={nodes}
        edges={[wire]}
        onToggleGroup={() => {}}
        onOpen={() => {}}
        ariaLabel="map"
      />
    );
    const { rerender } = render(draw([web, db]));
    await waitFor(() => expect(placed).toBe(3), SLOW);
    const before = new Map(handed.nodes.map((each) => [each.id, each]));
    const edge = handed.edges[0];

    rerender(draw([web, { ...db, tone: "err" }]));
    const after = new Map(handed.nodes.map((each) => [each.id, each]));
    expect(after.get("web")).toBe(before.get("web"));
    expect(after.get("group:shop")).toBe(before.get("group:shop"));
    expect(after.get("db")).not.toBe(before.get("db"));
    expect(handed.edges[0]).toBe(edge);
  });

  /** A layout that failed left a blank canvas under a header counting objects. Fails if the canvas does not say so. */
  it("says the layout failed rather than drawing nothing", async () => {
    render(canvas(["broken"]));
    expect(await screen.findByRole("alert", undefined, SLOW)).toHaveTextContent(
      "The map could not be laid out"
    );
    expect(screen.getByRole("alert")).toHaveTextContent("elk gave up");
  });

  /**
   * A route's line to its Gateway left the route's right side, turned back
   * and entered the Gateway from its left, across both cards. Fails if a
   * reversed edge is handed to React Flow from its `from` rather than from
   * its `to`, or an ordinary one is turned round.
   */
  it("draws a route's edge from its Gateway's side, and every other edge as handed", async () => {
    const attaches = {
      id: "web>attachesTo>public",
      from: "web",
      to: "public",
      tone: "ok" as const,
      reversed: true,
    };
    const selects = {
      id: "svc>web",
      from: "svc",
      to: "web",
      tone: "ok" as const,
    };
    render(
      <GraphCanvas
        groups={[group("shop")]}
        nodes={["web", "public", "svc"].map((id) => node(id, "shop"))}
        edges={[attaches, selects]}
        onToggleGroup={() => {}}
        onOpen={() => {}}
        ariaLabel="map"
      />
    );
    await waitFor(() => expect(placed).toBe(4), SLOW);
    const ends = (id: string) =>
      (handed.edges as { id: string; source: string; target: string }[]).find(
        (each) => each.id === id
      );
    expect(ends(attaches.id)).toMatchObject({
      source: "public",
      target: "web",
    });
    expect(ends(selects.id)).toMatchObject({ source: "svc", target: "web" });
  });

  /**
   * An edge between two cards was a straight run from one port to the other
   * wherever the cards stood, through whatever lay between. Fails if an
   * edge the layout routed is not handed to React Flow with its route.
   */
  it("hands an edge between groups to React Flow along the layout's route", async () => {
    render(
      <GraphCanvas
        groups={[group("loadgen"), group("istio")]}
        nodes={[node("lg", "loadgen"), node("gw", "istio")]}
        edges={[{ id: "lg>gw", from: "lg", to: "gw", tone: "ok" }]}
        onToggleGroup={() => {}}
        onOpen={() => {}}
        ariaLabel="map"
      />
    );
    await waitFor(() => {
      const edge = (
        handed.edges as { id: string; data?: { route?: unknown[] } }[]
      ).find((each) => each.id === "lg>gw");
      expect(edge?.data?.route?.length).toBeGreaterThanOrEqual(2);
    }, SLOW);
  });

  /**
   * The words of a hovered node's lines were drawn on the lines, over the
   * neighbouring nodes, and could not be read. Fails if they are not listed
   * in one place beside the hovered node, or stay once it is left.
   */
  it("lists the words of a hovered node's lines beside it", async () => {
    Object.assign(view, { width: 800, height: 600 });
    render(
      <GraphCanvas
        groups={[group("shop")]}
        nodes={[node("productpage", "shop"), node("reviews", "shop")]}
        edges={[
          {
            id: "pp>rev",
            from: "productpage",
            to: "reviews",
            tone: "ok",
            label: "productpage → reviews",
            sub: "0.731 req/s · 0% errors",
          },
        ]}
        onToggleGroup={() => {}}
        onOpen={() => {}}
        ariaLabel="map"
      />
    );
    const target = await screen.findByRole(
      "button",
      { name: /productpage/ },
      SLOW
    );
    fireEvent.mouseEnter(target);
    expect(
      screen.getByRole("list", { name: "The lines from productpage" })
    ).toHaveTextContent("productpage → reviews · 0.731 req/s · 0% errors");
    fireEvent.mouseLeave(target);
    expect(screen.queryByRole("list")).toBeNull();
  });
});
