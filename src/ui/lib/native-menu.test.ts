// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import userEvent from "@testing-library/user-event";

import { keepNativeMenuForText, openMenusFromKeys } from "./native-menu";

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

describe("the Menu key and Shift+F10", () => {
  let stopKeys: () => void;
  beforeEach(() => {
    stopKeys = openMenusFromKeys();
  });
  afterEach(() => stopKeys());

  /** What opened, where, and whether the webview was left a key to answer. */
  const watch = () => {
    const opened: { on: Element; x: number; y: number }[] = [];
    const handled: boolean[] = [];
    const onMenu = (event: MouseEvent) =>
      opened.push({
        on: event.target as Element,
        x: event.clientX,
        y: event.clientY,
      });
    const onKey = (event: KeyboardEvent) =>
      handled.push(event.defaultPrevented);
    window.addEventListener("contextmenu", onMenu);
    window.addEventListener("keydown", onKey);
    return {
      opened,
      handled,
      stop: () => {
        window.removeEventListener("contextmenu", onMenu);
        window.removeEventListener("keydown", onKey);
      },
    };
  };

  const at = (element: Element, left: number, bottom: number) =>
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      ...element.getBoundingClientRect(),
      left,
      bottom,
    });

  /**
   * Dana focused the new tab button and pressed the Menu key: the webview sent
   * the menu to whatever lay under the button's corner, so nothing opened, and
   * on Events the list's selected row opened its menu at the window's corner.
   * Fails if the key opens anything but the focused control's own menu, or
   * anywhere but under it.
   */
  it.each([
    ["the Menu key", "{ContextMenu}"],
    ["Shift+F10", "{Shift>}{F10}{/Shift}"],
  ])("%s opens the focused control's menu under it", async (_key, keys) => {
    const button = make("<div><button>+</button></div>").querySelector(
      "button"
    )!;
    at(button, 240, 30);
    button.focus();
    const seen = watch();

    await userEvent.keyboard(keys);

    seen.stop();
    expect(seen.opened).toEqual([{ on: button, x: 240, y: 30 }]);
    expect(seen.handled.at(-1)).toBe(true);
  });

  /** Shift+F10 in a field is how its cut and paste are reached from the keyboard. */
  it("leaves a text field's own menu to the webview", async () => {
    make("<input />");
    (document.querySelector("input") as HTMLInputElement).focus();
    const seen = watch();

    await userEvent.keyboard("{Shift>}{F10}{/Shift}");

    seen.stop();
    expect(seen.opened).toEqual([]);
    expect(seen.handled.at(-1)).toBe(false);
  });

  /** A focused table row opens its own menu from its own key handler. */
  it("opens no second menu for a key the focused control answered", async () => {
    const row = make('<div tabindex="0">pod-1</div>') as HTMLElement;
    row.addEventListener("keydown", (event) => event.preventDefault());
    row.focus();
    const seen = watch();

    await userEvent.keyboard("{ContextMenu}");

    seen.stop();
    expect(seen.opened).toEqual([]);
  });

  /** With nothing focused there is no menu to open, and the webview's own does not belong. */
  it("opens nothing, and leaves the webview nothing to open, with nothing focused", async () => {
    make("<div>pods</div>");
    (document.activeElement as HTMLElement | null)?.blur();
    const seen = watch();

    await userEvent.keyboard("{ContextMenu}");

    seen.stop();
    expect(seen.opened).toEqual([]);
    expect(seen.handled.at(-1)).toBe(true);
  });
});
