// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { keepNativeMenuForText } from "./native-menu";

let stop: () => void;
beforeEach(() => {
  stop = keepNativeMenuForText();
});
afterEach(() => {
  stop();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

const rightClick = (element: Element) =>
  element.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
  );

const make = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
};

describe("the webview's own menu", () => {
  /** Back, Reload and Inspect Element answered a right click on any row. */
  it("is withheld everywhere that is not text", () => {
    expect(rightClick(make("<div><span>pod-1</span></div>"))).toBe(false);
  });

  /** Copy and paste live there; taking the menu away takes them too. */
  it.each([
    ["a text field", "<input />"],
    ["a text area", "<textarea></textarea>"],
    ["the code editor", '<div class="cm-editor"><div>key: v</div></div>'],
    ["the terminal", '<div class="xterm"><canvas></canvas></div>'],
  ])("is left alone in %s", (_where, html) => {
    const root = make(html);
    expect(rightClick(root.querySelector("div, canvas") ?? root)).toBe(true);
  });

  /**
   * Radix's context menu trigger skips an event already prevented, so a
   * capturing listener kept the new tab button's menu shut on every right
   * click. Fails if the app's own handler sees the event prevented.
   */
  it("is withheld only after the app's own menu had the event", () => {
    const row = make("<div><span>pod-1</span></div>");
    let seenPrevented: boolean | null = null;
    row.addEventListener("contextmenu", (event) => {
      seenPrevented = event.defaultPrevented;
    });
    expect(rightClick(row)).toBe(false);
    expect(seenPrevented).toBe(false);
  });

  it("is left alone over text the reader selected", () => {
    const line = make("<p>error: connection refused</p>");
    window.getSelection()!.selectAllChildren(line);
    expect(rightClick(line)).toBe(true);
    expect(rightClick(make("<p>elsewhere</p>"))).toBe(false);
  });
});
