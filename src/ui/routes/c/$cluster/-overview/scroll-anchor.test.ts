// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { ANCHOR_ROWS, holdScroll } from "./scroll-anchor";

/** Where each element sits on the page, top and height, before the scroller moves it. */
const at = new Map<Element, { top: number; height: number }>();
let scrolled = 0;
let resized: () => void = () => {};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const place = at.get(this);
      if (!place) return new DOMRect(0, 0, 0, 0);
      const top = place.top - (this.id === "port" ? 0 : scrolled);
      return new DOMRect(0, top, 100, place.height);
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  at.clear();
  scrolled = 0;
  document.body.innerHTML = "";
});

const ROW = 26;

/** The Overview in small: a header, Needs attention with `rows` rows, and the Workloads card under it. */
function overview(rows: number) {
  document.body.innerHTML = `
    <div id="port" style="overflow-y: auto">
      <div id="page">
        <div id="header"></div>
        <section id="attention"><div ${ANCHOR_ROWS}></div></section>
        <section id="workloads"></section>
      </div>
    </div>`;
  const port = document.getElementById("port")!;
  Object.defineProperty(port, "scrollTop", {
    get: () => scrolled,
    set: (value: number) => {
      scrolled = Math.max(0, value);
    },
  });
  const list = document.querySelector(`[${ANCHOR_ROWS}]`)!;
  // New rows arrive at the top of the list and leave from it, the rows
  // already drawn staying the same elements as React keeps them.
  const lay = (count: number) => {
    while (list.children.length < count)
      list.prepend(document.createElement("div"));
    while (list.children.length > count) list.firstElementChild!.remove();
    at.set(port, { top: 0, height: 600 });
    at.set(document.getElementById("header")!, { top: 0, height: 30 });
    at.set(document.getElementById("attention")!, {
      top: 50,
      height: count * ROW,
    });
    [...list.children].forEach((row, index) =>
      at.set(row, { top: 50 + index * ROW, height: ROW })
    );
    at.set(document.getElementById("workloads")!, {
      top: 70 + count * ROW,
      height: 105,
    });
  };
  lay(rows);
  const card = () =>
    document.getElementById("workloads")!.getBoundingClientRect().top;
  const grow = (count: number) => {
    lay(count);
    resized();
  };
  return { port, page: document.getElementById("page")!, card, grow };
}

describe("the Overview while Needs attention changes", () => {
  /**
   * Dana read the Workloads card scrolled into the page, and it jumped 15 to
   * 135 px each time a Needs attention row came or went. Fails if a row added
   * or removed above what the reader looks at moves it.
   */
  it("keeps the Workloads card where it is while rows above it come and go", () => {
    const { port, page, card, grow } = overview(12);
    port.scrollTop = 200;
    const stop = holdScroll(page);
    const before = card();
    grow(15);
    expect(card()).toBe(before);
    grow(9);
    expect(card()).toBe(before);
    stop();
  });

  /** Fails if the card moves while the pointer is on it, even with the list's start on screen above it. */
  it("keeps what is under the pointer in place, from the top of the page too", () => {
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
      run(0);
      return 1;
    });
    const { port, page, card, grow } = overview(4);
    const stop = holdScroll(page);
    port.dispatchEvent(
      new PointerEvent("pointermove", { clientY: card() + 10 })
    );
    const before = card();
    grow(6);
    expect(card()).toBe(before);
    stop();
  });

  /** At the top of the page with the pointer elsewhere, the list grows downwards; fails if the page scrolls instead. */
  it("lets the page grow downwards when the reader is at its top", () => {
    const { port, page, grow } = overview(4);
    const stop = holdScroll(page);
    grow(8);
    expect(port.scrollTop).toBe(0);
    stop();
  });
});
