import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { render, waitFor } from "@testing-library/react";

import { GraphCanvas } from "./GraphCanvas";
import type { GraphEdge, GraphGroup, GraphNode } from "./types";

// ELK is loaded and run for real: under a loaded machine that alone outlasts
// the default five seconds the waits below were written around.
vi.setConfig({ testTimeout: 20_000 });

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    // Tells at once, so React Flow measures each node's handles and draws
    // the edges between them, as the webview does.
    class {
      constructor(private tell: ResizeObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.tell(
            [{ target } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          )
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
});
beforeAll(() => {
  // What React Flow reads the zoom off a measured node with.
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
    }
  );
});
// jsdom lays nothing out; React Flow measures a node before it draws the
// edges at its handles (React Flow's own recipe for testing under jsdom).
const sizes = ["offsetWidth", "offsetHeight"] as const;
const native = sizes.map((size) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, size)
);
beforeAll(() => {
  for (const size of sizes)
    Object.defineProperty(HTMLElement.prototype, size, {
      configurable: true,
      get: () => 100,
    });
});
afterAll(() => {
  vi.unstubAllGlobals();
  sizes.forEach((size, at) => {
    const was = native[at];
    if (was) Object.defineProperty(HTMLElement.prototype, size, was);
  });
});

const group = (id: string, collapsed: boolean): GraphGroup => ({
  id,
  label: id,
  collapsed,
  tone: "ok",
  summary: "Deployment 1",
});
const node = (id: string): GraphNode => ({
  id,
  group: "shop",
  kind: "Deployment",
  label: id,
  tone: "ok",
});
const edge: GraphEdge = { id: "web>api", from: "web", to: "api", tone: "ok" };

/** The wrapper React Flow draws a node or a group in, by its id. */
const wrapper = (id: string) =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);

describe("the map under the mouse", () => {
  /**
   * In the webview no click, double click, hover or fold reached the map:
   * with nothing selectable or draggable, React Flow writes
   * `pointer-events: none` on every node's wrapper, and jsdom, which ignores
   * CSS, let every other test click through it. Fails if a node's, an open
   * group's or a card's wrapper does not take the pointer, if an edge's
   * label does not, or if a drag across a node selects its text.
   */
  it("lets the pointer reach every node, group and edge label it draws", async () => {
    render(
      <div style={{ width: 800, height: 600 }}>
        <GraphCanvas
          groups={[group("shop", false), group("billing", true)]}
          nodes={[node("web"), node("api")]}
          edges={[edge]}
          onToggleGroup={() => {}}
          onOpen={() => {}}
          onOpenEdge={() => {}}
          ariaLabel="map"
        />
      </div>
    );
    await waitFor(() => expect(wrapper("web")).not.toBeNull(), {
      timeout: 15_000,
    });
    for (const id of ["web", "api", "group:shop", "group:billing"])
      expect(wrapper(id)?.style.pointerEvents, id).toBe("all");
    expect(wrapper("web")?.firstElementChild).toHaveClass("select-none");
    const label = await waitFor(() => {
      const found = document.querySelector(
        ".react-flow__edgelabel-renderer > div"
      );
      expect(found).not.toBeNull();
      return found;
    });
    expect(label).toHaveClass("pointer-events-auto");
  });
});
