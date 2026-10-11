// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { KEYS_ATTRIBUTE, startFocusModality } from "./focus-modality";

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
