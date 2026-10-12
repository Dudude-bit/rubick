import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, fireEvent, screen } from "@testing-library/react";
import type { AnyRouter } from "@tanstack/react-router";

import { DETAIL_TAB_OPEN, TYPING_MS } from "@/lib/shortcuts";
import { renderWithRouter } from "@/test/render";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { useShortcuts } from "./useShortcuts";

function Probe() {
  useShortcuts();
  return <input aria-label="search" />;
}

/** Mounted on every address in the cluster, so a chord's landing keeps it on screen. */
async function mount(ui = <Probe />): Promise<AnyRouter> {
  const { router } = await renderWithRouter(ui, {
    at: "/c/prod",
    route: "/c/$cluster/$",
  });
  vi.useFakeTimers();
  return router;
}

/**
 * With the list of shortcuts really on screen, which is the only way to see
 * what it does to the keys. Mounting the hook alone leaves no dialog in the
 * document, and every assertion about stepping aside for one then passes
 * against behaviour the app does not have.
 */
const mountWithOverlay = () =>
  mount(
    <>
      <Probe />
      <ShortcutsOverlay />
    </>
  );

/** One key, then the pause a person leaves before the next. */
const press = (key: string, target: Element | Window = window) =>
  act(() => {
    fireEvent.keyDown(target, { key });
    vi.advanceTimersByTime(TYPING_MS);
  });

/** Keys as WebKitGTK hands over text typed while the page was busy: all at once. */
const burst = (keys: string, target: Element | Window = window) =>
  act(() => {
    for (const key of keys) fireEvent.keyDown(target, { key });
    vi.advanceTimersByTime(TYPING_MS);
  });

const asked = vi.fn();

/** A navigate writes history before it returns, so reading it at once cannot miss one still loading. */
const stayed = (router: AnyRouter) =>
  expect(router.history.location.pathname).toBe("/c/prod");

const landedOn = (router: AnyRouter, pathname: string) =>
  vi.waitFor(() => expect(router.state.location.pathname).toBe(pathname));

beforeEach(() => {
  useShortcutsOverlayStore.setState({ open: false });
  asked.mockClear();
  window.addEventListener(DETAIL_TAB_OPEN, asked);
});

afterEach(() => {
  window.removeEventListener(DETAIL_TAB_OPEN, asked);
  vi.useRealTimers();
});

describe("the keys that are the same on every screen", () => {
  it("goes where a g-chord points", async () => {
    const router = await mount();
    press("g");
    press("p");
    await landedOn(router, "/c/prod/pods");
  });

  /** A chord that waited too long is two letters, not one shortcut. */
  it("forgets a g that was pressed too long ago", async () => {
    const router = await mount();
    press("g");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    press("p");
    stayed(router);
  });

  it("opens the list of itself on ?", async () => {
    await mount();
    press("?");
    expect(useShortcutsOverlayStore.getState().open).toBe(true);
    press("?");
    expect(useShortcutsOverlayStore.getState().open).toBe(false);
  });

  /**
   * The same two presses with the list actually drawn. It is a dialog and it
   * holds the focus, so a handler that steps aside for any layer opened it
   * and could never close it — and the test above passed anyway, because
   * nothing was rendered to step aside for.
   */
  it("closes the list with the same key that opened it, drawn", async () => {
    await mountWithOverlay();
    press("?");
    expect(useShortcutsOverlayStore.getState().open).toBe(true);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    press("?");
    expect(useShortcutsOverlayStore.getState().open).toBe(false);
  });

  /**
   * A peek panel is a non-modal Sheet the reader is meant to keep working
   * behind, and a plain row click opens one. Asking whether any dialog exists
   * anywhere made every one of these keys dead for as long as it was up.
   */
  it("still answers a chord while a non-modal panel is open behind it", async () => {
    const router = await mount();
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("data-state", "open");
    document.body.appendChild(panel);
    press("g");
    press("p");
    await landedOn(router, "/c/prod/pods");
    panel.remove();
  });

  /** And a layer the reader is actually inside keeps its own keys. */
  it("stays quiet when the focus is inside a layer", async () => {
    const router = await mount();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.appendChild(item);
    document.body.appendChild(menu);
    item.focus();
    press("g", item);
    press("p", item);
    stayed(router);
    menu.remove();
  });

  /**
   * Caps Lock is a state a reader can be in without noticing, and the
   * browser reports "G" for the same physical key. Every neighbouring
   * handler here lowercases; this one compared raw, so the chords and the
   * page keys died silently while the modified shortcuts listed beside them
   * in the overlay went on working.
   */
  it("answers a chord typed with caps lock on", async () => {
    const router = await mount();
    press("G");
    press("P");
    await landedOn(router, "/c/prod/pods");
  });

  /** F1 is where a newcomer looks for help; it did nothing. */
  it("opens and closes the help on F1, from a field and from the help itself", async () => {
    await mountWithOverlay();
    press("F1", screen.getByLabelText("search"));
    expect(useShortcutsOverlayStore.getState().open).toBe(true);
    press("F1", screen.getByRole("dialog"));
    expect(useShortcutsOverlayStore.getState().open).toBe(false);
  });

  /** A `g` typed into a search box is a letter. */
  it("stays quiet inside a field", async () => {
    const router = await mount();
    const field = screen.getByLabelText("search");
    press("g", field);
    press("p", field);
    stayed(router);
    press("?", field);
    expect(useShortcutsOverlayStore.getState().open).toBe(false);
  });

  /**
   * Marco clicked the Checks tab's Resolve field and typed at once while the
   * page was busy: WebKitGTK handed the keys over before the click, the field
   * had no focus yet, and an l in the name opened Logs. Fails if letters
   * arriving together act as page keys or chords.
   */
  it("reads letters that arrive together as typing, not as page keys", async () => {
    const router = await mount();
    burst("checkout-api.local");
    burst("logs-db.shop");
    burst("gpu-node");
    expect(asked).not.toHaveBeenCalled();
    stayed(router);
  });

  /**
   * The click on a field can land and the focus still miss it. Fails if a
   * page key acts right after the pointer pressed a field, or if one pressed
   * while it waits does not stop it.
   */
  it("leaves the letters to a field the pointer just pressed", async () => {
    await mount();
    const field = screen.getByLabelText("search");
    act(() => {
      fireEvent.keyDown(window, { key: "l" });
      fireEvent.pointerDown(field);
      vi.advanceTimersByTime(TYPING_MS);
    });
    press("e");
    expect(asked).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    press("e");
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("asks the page to open the tab a letter names", async () => {
    await mount();
    press("l");
    expect(asked).toHaveBeenCalledTimes(1);
    expect(
      (asked.mock.calls[0][0] as CustomEvent<{ tab: string }>).detail.tab
    ).toBe("logs");
  });
});
