// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  KEYS_ATTRIBUTE,
  startFocusModality,
  startFocusWrap,
} from "./focus-modality";

let stop: () => void = () => {};
afterEach(() => stop());

const root = document.documentElement;
const press = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent("keydown", init));
const click = () => window.dispatchEvent(new Event("pointerdown"));

describe("the keyboard flag on the root", () => {
  /** Dana clicked Overview, then Shift+Tab, and no ring ever showed. Fails if a key after a click does not raise the flag. */
  it("goes up on a key after a click, Shift+Tab under WebKitGTK's name included", () => {
    stop = startFocusModality();
    click();
    expect(root.hasAttribute(KEYS_ATTRIBUTE)).toBe(false);
    press({ key: "Unidentified", shiftKey: true });
    expect(root.hasAttribute(KEYS_ATTRIBUTE)).toBe(true);
  });

  /** A ring on whatever a click focused is noise. Fails if a click leaves the flag up. */
  it("comes down on the next click", () => {
    stop = startFocusModality();
    press({ key: "Tab" });
    click();
    expect(root.hasAttribute(KEYS_ATTRIBUTE)).toBe(false);
  });

  /** Ctrl+click and a bare Shift are the mouse's companions, not keyboard travel. */
  it("stays down for a chord or a lone modifier", () => {
    stop = startFocusModality();
    press({ key: "Control", ctrlKey: true });
    press({ key: "k", ctrlKey: true });
    press({ key: "Shift", shiftKey: true });
    expect(root.hasAttribute(KEYS_ATTRIBUTE)).toBe(false);
  });

  /** The flag does nothing unless the stylesheet reads it. Fails if index.css stops ringing :focus under it. */
  it("is what index.css widens the focus-visible variant and the bare outline to", () => {
    const css = readFileSync("src/ui/index.css", "utf8");
    const under = `:root[${KEYS_ATTRIBUTE}]`;
    const variant = css.slice(css.indexOf("@custom-variant focus-visible {"));
    expect(variant).not.toBe(css);
    expect(variant.slice(0, variant.indexOf("\n}"))).toContain(
      `${under} &:focus`
    );
    expect(css).toContain(`:where(:focus-visible, ${under} :focus)`);
  });
});

describe("Tab at either end of the window", () => {
  const stops = () => {
    document.body.innerHTML = `
      <button id="cluster">acme-staging</button>
      <button id="hidden" hidden>gone</button>
      <span tabindex="-1" id="region">toasts</span>
      <button id="theme">dark</button>`;
    return {
      cluster: document.getElementById("cluster")!,
      theme: document.getElementById("theme")!,
    };
  };
  const tab = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
      ...init,
    });
    window.dispatchEvent(event);
    return event;
  };

  /**
   * Dana's Shift+Tab off the sidebar's cluster name landed on nothing for one
   * press before the status bar: WebKitGTK handed the focus out of a webview
   * that has nowhere to hand it. Fails if Shift+Tab on the first stop or Tab
   * on the last does not wrap to the other end.
   */
  it("wraps to the other end instead of leaving the window", () => {
    stop = startFocusWrap();
    const { cluster, theme } = stops();
    cluster.focus();
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(theme);
    tab();
    expect(document.activeElement).toBe(cluster);
  });

  /** WebKitGTK names Shift+Tab "Unidentified". Fails if that press leaves the window. */
  it("wraps Shift+Tab under WebKitGTK's name too", () => {
    stop = startFocusWrap();
    const { cluster, theme } = stops();
    cluster.focus();
    tab({
      key: "Unidentified",
      shiftKey: true,
      keyCode: 9,
    } as KeyboardEventInit);
    expect(document.activeElement).toBe(theme);
  });

  /** Fails if a press between the ends is taken from the browser, or one a dialog's trap already handled is moved again. */
  it("leaves every other press to the browser and to focus traps", () => {
    stop = startFocusWrap();
    const { cluster, theme } = stops();
    theme.focus();
    expect(tab({ shiftKey: true }).defaultPrevented).toBe(false);
    cluster.focus();
    const trapped = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      cancelable: true,
    });
    trapped.preventDefault();
    window.dispatchEvent(trapped);
    expect(document.activeElement).toBe(cluster);
  });
});

describe("Tab past a stop that is cut out of sight", () => {
  const box = (el: HTMLElement, left: number, right: number) =>
    (el.getBoundingClientRect = () =>
      ({
        left,
        right,
        top: 0,
        bottom: 24,
        width: right - left,
        height: 24,
      }) as DOMRect);

  /**
   * The status bar wraps a control it has no room for onto a line its
   * `overflow: hidden` cuts off, and Tab still stopped there: presses with no
   * ring anywhere before the focus wrapped. Fails if Tab, forward or back,
   * lands on a stop an overflow-hidden ancestor has clipped away.
   */
  it("skips it forward and back, wrapping when nothing visible is left", () => {
    stop = startFocusWrap();
    document.body.innerHTML = `
      <button id="first">first</button>
      <div id="bar" style="overflow-x:hidden;overflow-y:hidden"><button id="seen">seen</button><button id="cut">cut</button></div>`;
    const [first, seen, cut, bar] = ["first", "seen", "cut", "bar"].map((id) =>
      document.getElementById(id)!
    );
    box(bar, 0, 100);
    box(first, 0, 50);
    box(seen, 10, 60);
    box(cut, 120, 180);
    const tab = (init: KeyboardEventInit = {}) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", cancelable: true, ...init })
      );
    first.focus();
    tab();
    expect(document.activeElement).toBe(first);
    seen.focus();
    tab();
    expect(document.activeElement).toBe(first);
    first.focus();
    tab({ shiftKey: true });
    expect(document.activeElement).toBe(seen);
  });
});

describe("Tab past a stop painted at no opacity", () => {
  /**
   * A control that is in the Tab order and drawn at opacity 0 takes a press
   * and shows no ring. Fails if Tab, forward or back, lands on one, or
   * does not wrap past it when it is the last stop.
   */
  it("skips it forward and back and wraps past it at the end", () => {
    stop = startFocusWrap();
    document.body.innerHTML = `
      <button id="first">first</button>
      <button id="last">last</button>
      <div style="opacity:0"><button id="ghost">ghost</button></div>`;
    const [first, last, ghost] = ["first", "last", "ghost"].map((id) =>
      document.getElementById(id)!
    );
    const tab = (init: KeyboardEventInit = {}) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", cancelable: true, ...init })
      );
    last.focus();
    tab();
    expect(document.activeElement).toBe(first);
    expect(document.activeElement).not.toBe(ghost);
    first.focus();
    tab({ shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
