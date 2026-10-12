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
