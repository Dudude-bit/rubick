import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

import { DETAIL_TAB_OPEN } from "@/lib/shortcuts";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";
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
