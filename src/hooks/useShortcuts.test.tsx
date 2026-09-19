import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { DETAIL_TAB_OPEN } from "@/lib/shortcuts";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";
import { ShortcutsOverlay } from "@/components/layout/ShortcutsOverlay";
import { useShortcuts } from "./useShortcuts";

function Probe() {
  useShortcuts();
  const { pathname } = useLocation();
  return (
    <>
      <span data-testid="path">{pathname}</span>
      <input aria-label="search" />
    </>
  );
}

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Probe />
    </MemoryRouter>
  );

/**
 * With the list of shortcuts really on screen, which is the only way to see
 * what it does to the keys. Mounting the hook alone leaves no dialog in the
 * document, and every assertion about stepping aside for one then passes
 * against behaviour the app does not have.
 */
const mountWithOverlay = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Probe />
      <ShortcutsOverlay />
    </MemoryRouter>
  );

const press = (key: string, target: Element | Window = window) =>
  act(() => {
    fireEvent.keyDown(target, { key });
  });

beforeEach(() => {
  vi.useFakeTimers();
  useShortcutsOverlayStore.setState({ open: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the keys that are the same on every screen", () => {
  it("goes where a g-chord points", () => {
    mount();
    press("g");
    press("p");
    expect(screen.getByTestId("path")).toHaveTextContent("/pods");
  });

  /** A chord that waited too long is two letters, not one shortcut. */
  it("forgets a g that was pressed too long ago", () => {
    mount();
    press("g");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    press("p");
    expect(screen.getByTestId("path")).toHaveTextContent("/");
  });

  it("opens the list of itself on ?", () => {
    mount();
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
  it("closes the list with the same key that opened it, drawn", () => {
    mountWithOverlay();
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
  it("still answers a chord while a non-modal panel is open behind it", () => {
    mount();
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("data-state", "open");
    document.body.appendChild(panel);
    press("g");
    press("p");
    expect(screen.getByTestId("path")).toHaveTextContent("/pods");
    panel.remove();
  });

  /** And a layer the reader is actually inside keeps its own keys. */
  it("stays quiet when the focus is inside a layer", () => {
    mount();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.appendChild(item);
    document.body.appendChild(menu);
    item.focus();
    press("g", item);
    press("p", item);
    expect(screen.getByTestId("path")).toHaveTextContent("/");
    menu.remove();
  });

  /**
   * Caps Lock is a state a reader can be in without noticing, and the
   * browser reports "G" for the same physical key. Every neighbouring
   * handler here lowercases; this one compared raw, so the chords and the
   * page keys died silently while the modified shortcuts listed beside them
   * in the overlay went on working.
   */
  it("answers a chord typed with caps lock on", () => {
    mount();
    press("G");
    press("P");
    expect(screen.getByTestId("path")).toHaveTextContent("/pods");
  });

  /** A `g` typed into a search box is a letter. */
  it("stays quiet inside a field", () => {
    mount();
    const field = screen.getByLabelText("search");
    press("g", field);
    press("p", field);
    expect(screen.getByTestId("path")).toHaveTextContent("/");
    press("?", field);
    expect(useShortcutsOverlayStore.getState().open).toBe(false);
  });

  it("asks the page to open the tab a letter names", () => {
    mount();
    const asked = vi.fn();
    window.addEventListener(DETAIL_TAB_OPEN, asked);
    press("l");
    expect(asked).toHaveBeenCalledTimes(1);
    expect(
      (asked.mock.calls[0][0] as CustomEvent<{ tab: string }>).detail.tab
    ).toBe("logs");
    window.removeEventListener(DETAIL_TAB_OPEN, asked);
  });
});
