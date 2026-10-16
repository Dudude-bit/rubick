// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { revealInScroller } from "./reveal";

const box = (top: number, height: number) =>
  ({ top, bottom: top + height, height }) as DOMRect;

/** A 100px port showing rows 20px tall, one of them at `rowTop` on screen. */
function layout(rowTop: number) {
  const page = document.createElement("div");
  page.style.overflowY = "auto";
  const port = document.createElement("div");
  port.style.overflowY = "auto";
  const row = document.createElement("div");
  port.append(row);
  page.append(port);
  document.body.append(page);
  for (const [element, scroll, client] of [
    [page, 5000, 800],
    [port, 1000, 100],
  ] as const) {
    Object.defineProperty(element, "scrollHeight", { value: scroll });
    Object.defineProperty(element, "clientHeight", { value: client });
  }
  port.getBoundingClientRect = () => box(0, 100);
  row.getBoundingClientRect = () => box(rowTop, 20);
  return { page, port, row };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("revealing a row", () => {
  /** Would break if it fell back to scrollIntoView, which moves the page too. */
  it("scrolls the nearest port down to a row below it, and nothing else", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { page, port, row } = layout(130);
    revealInScroller(row);
    expect(port.scrollTop).toBe(50);
    expect(page.scrollTop).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
    scrollTo.mockRestore();
  });

  /** A row under the sticky header is hidden, not shown. */
  it("brings a row out from under what covers the top of the port", () => {
    const { port, row } = layout(10);
    port.scrollTop = 200;
    revealInScroller(row, 24);
    expect(port.scrollTop).toBe(186);
  });

  it("leaves a row that is already in view where it is", () => {
    const { port, row } = layout(40);
    port.scrollTop = 200;
    revealInScroller(row, 24);
    expect(port.scrollTop).toBe(200);
  });
});
