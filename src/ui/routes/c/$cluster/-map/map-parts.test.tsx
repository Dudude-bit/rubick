import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen } from "@testing-library/react";

import { MapContext, type MapActions } from "./map-context";
import { DOUBLE_CLICK_MS, ObjectNode } from "./map-parts";
import type { GraphNode } from "./types";

vi.mock("@xyflow/react", async (original) => ({
  ...(await original<typeof import("@xyflow/react")>()),
  Handle: () => null,
}));

const node: GraphNode = {
  id: "apps/Deployment/shop/cart",
  group: "shop",
  kind: "Deployment",
  label: "cart",
  tone: "ok",
};

function draw() {
  const actions: MapActions = {
    open: vi.fn(),
    pressed: vi.fn(),
    toggle: vi.fn(),
    setActive: vi.fn(),
    reveal: vi.fn(),
  };
  const Node = ObjectNode as unknown as (props: {
    id: string;
    data: { node: GraphNode };
  }) => React.ReactNode;
  render(
    <MapContext.Provider value={actions}>
      <Node id={node.id} data={{ node }} />
    </MapContext.Provider>
  );
  return { actions, target: screen.getByRole("button", { name: /cart/ }) };
}

describe("a node on the map", () => {
  /** The brief's contract with the keyboard: Enter goes to the page, Space and a click open the peek. */
  it("opens its page on Enter, its peek on Space and click", () => {
    vi.useFakeTimers();
    try {
      const { actions, target } = draw();
      fireEvent.keyDown(target, { key: "Enter" });
      fireEvent.keyDown(target, { key: " " });
      fireEvent.click(target, { detail: 1 });
      vi.advanceTimersByTime(DOUBLE_CLICK_MS);
      expect(vi.mocked(actions.open).mock.calls.map(([, how]) => how)).toEqual([
        "page",
        "peek",
        "peek",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A double click opened the peek, which narrowed the canvas and moved the
   * node from under the second click, so the page never opened. Fails if a
   * quick double click opens the peek at all, or its first click does not
   * press the node for the canvas to open the page of.
   */
  it("opens no peek on a quick double click, and presses the node its first click landed on", () => {
    vi.useFakeTimers();
    try {
      const { actions, target } = draw();
      fireEvent.click(target, { detail: 1 });
      fireEvent.click(target, { detail: 2 });
      fireEvent.doubleClick(target);
      vi.advanceTimersByTime(DOUBLE_CLICK_MS * 2);
      expect(actions.open).not.toHaveBeenCalled();
      expect(actions.pressed).toHaveBeenCalledTimes(1);
      expect(vi.mocked(actions.pressed).mock.calls[0][0]).toBe(node);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Every node and rail row wore the same dashed circle, the mark of a kind
   * the app does not know, and no node said its kind. Fails if a built-in
   * node loses its own glyph or its kind word.
   */
  it("wears its kind's own glyph and says its kind", () => {
    const { target } = draw();
    const glyph = target.querySelector("svg");
    expect(glyph).not.toHaveClass("lucide-circle-dashed");
    expect(glyph).toHaveClass("lucide");
    expect(target).toHaveTextContent("Deployment");
  });

  /** A node the keyboard reaches off screen is brought into view, or Tab walks the reader somewhere they cannot see. */
  it("asks to be brought into view when the keyboard reaches it", () => {
    const { actions, target } = draw();
    fireEvent.focus(target);
    expect(actions.reveal).toHaveBeenCalledWith(node.id);
  });
});
