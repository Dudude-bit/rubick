import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";

import { GraphCanvas } from "./GraphCanvas";
import type { GraphGroup, GraphNode } from "./types";

// ELK is loaded and run for real: under a loaded machine that alone outlasts
// the default five seconds the waits below were written around.
vi.setConfig({ testTimeout: 20_000 });

let placed = 0;
let handed: { nodes: { id: string }[]; edges: { id: string }[] } = {
  nodes: [],
  edges: [],
};
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

vi.mock("@xyflow/react", async (original) => ({
  ...(await original<typeof import("@xyflow/react")>()),
  ReactFlow: (props: typeof handed) => {
    placed = props.nodes.length;
    handed = props;
    return null;
  },
  Background: () => null,
  useReactFlow: () => ({ fitView }),
  useStoreApi: () => ({ getState: () => ({ width: 800, height: 600 }) }),
}));

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
   * The map opened zoomed in on the first card the stream drew, and stayed
   * there while the rest arrived. Fails if the view is fitted before the
   * layout is laid out, fitted again for a later delta, or not fitted again
   * when the key changes.
   */
  it("fits the first layout laid out and again after its key changes, never for a later delta", async () => {
    fitView.mockClear();
    fits.length = 0;
    const { rerender } = render(canvas(["argo"], "namespace"));
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1), SLOW);

    rerender(canvas(["argo", "billing"], "namespace"));
    await laidOut(2);
    expect(fitView).toHaveBeenCalledTimes(1);

    rerender(canvas(["argo", "billing", "shop"], "namespace\u0000whole"));
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(2), SLOW);
    rerender(
      canvas(["argo", "billing", "shop", "zoo"], "namespace\u0000whole")
    );
    await laidOut(4);
    expect(fits).toEqual([2, 6]);
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
});
