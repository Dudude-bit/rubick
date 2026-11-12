// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { holdTitlesOnResize } from "./hold-titles";

describe("a title under a parked pointer when the window is resized", () => {
  afterEach(() => vi.restoreAllMocks());

  const move = (clientX: number, clientY: number) =>
    document.dispatchEvent(
      Object.assign(new Event("pointermove"), { clientX, clientY })
    );

  /** Lena's resize left "Container created" floating over another row; fails if the title under the parked pointer is not held back until the pointer moves. */
  it("is held back until the pointer moves, and given back after", () => {
    const row = document.createElement("span");
    row.setAttribute("title", "Container created");
    document.body.append(row);
    Object.assign(document, { elementFromPoint: vi.fn(() => row) });
    const stop = holdTitlesOnResize();
    try {
      move(40, 60);
      window.dispatchEvent(new Event("resize"));
      expect(row.hasAttribute("title")).toBe(false);
      move(40, 60);
      expect(row.hasAttribute("title")).toBe(false);
      move(41, 60);
      expect(row.getAttribute("title")).toBe("Container created");
    } finally {
      stop();
      row.remove();
    }
  });
});
