import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { TOOLTIP_CARD } from "./tooltip";
import { TitleTooltips } from "./title-tooltips";

const tab = () => screen.getByRole("button", { name: "Events" });
const card = () => screen.queryByRole("tooltip");
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  render(
    <>
      <TitleTooltips />
      <button type="button" title="Events: 5">
        Events
      </button>
      <span data-testid="elsewhere">elsewhere</span>
    </>
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a native title", () => {
  /** Fails if a title is left to WebKit, which drew a square black box beside every rounded app tooltip. */
  it("is drawn in the app's tooltip card, with the browser's own box kept away", async () => {
    fireEvent.pointerOver(tab());
    expect(tab().hasAttribute("title")).toBe(false);
    await wait(699);
    expect(card()).toBeNull();
    await wait(1);
    expect(card()?.textContent).toBe("Events: 5");
    expect(card()?.className).toContain(TOOLTIP_CARD.split(" ")[0]);
    fireEvent.pointerOut(tab(), {
      relatedTarget: screen.getByTestId("elsewhere"),
    });
    expect(card()).toBeNull();
    expect(tab().getAttribute("title")).toBe("Events: 5");
  });

  /** Fails if a title stays up through a click or a context menu, which hid the menu's own first item. */
  it("goes away on a press or a menu and stays away until the pointer leaves", async () => {
    fireEvent.pointerOver(tab());
    await wait(700);
    expect(card()).not.toBeNull();
    fireEvent.contextMenu(tab());
    expect(card()).toBeNull();
    await wait(2000);
    expect(card()).toBeNull();
    fireEvent.pointerOut(tab(), {
      relatedTarget: screen.getByTestId("elsewhere"),
    });
    fireEvent.pointerOver(tab());
    await wait(700);
    expect(card()?.textContent).toBe("Events: 5");
  });
});
