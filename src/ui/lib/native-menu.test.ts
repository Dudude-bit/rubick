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

  it("is left alone over text the reader selected", () => {
    const line = make("<p>error: connection refused</p>");
    window.getSelection()!.selectAllChildren(line);
    expect(rightClick(line)).toBe(true);
    expect(rightClick(make("<p>elsewhere</p>"))).toBe(false);
  });
});
