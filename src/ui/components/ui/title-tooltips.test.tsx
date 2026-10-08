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
    fireEvent.pointerOver(tab(), { clientX: 10, clientY: 10 });
    await wait(700);
    expect(card()).not.toBeNull();
    fireEvent.contextMenu(tab(), { clientX: 10, clientY: 10 });
    expect(card()).toBeNull();
    await wait(2000);
    expect(card()).toBeNull();
    fireEvent.pointerOut(tab(), {
      relatedTarget: screen.getByTestId("elsewhere"),
    });
    fireEvent.pointerOver(tab(), { clientX: 30, clientY: 10 });
    await wait(700);
    expect(card()?.textContent).toBe("Events: 5");
  });

  /**
   * Dana's right click on a row put the status tooltip away, and it came
   * straight back when the live list redrew the row under the parked
   * pointer. Fails if a pointerover without movement brings it back.
   */
  it("stays away after a menu when the row is redrawn under a pointer that has not moved", async () => {
    fireEvent.pointerOver(tab(), { clientX: 10, clientY: 10 });
    await wait(700);
    fireEvent.contextMenu(tab(), { clientX: 10, clientY: 10 });
    expect(card()).toBeNull();

    fireEvent.pointerOut(tab(), {
      relatedTarget: screen.getByTestId("elsewhere"),
    });
    fireEvent.pointerOver(tab(), { clientX: 10, clientY: 10 });
    await wait(2000);
    expect(card()).toBeNull();

    fireEvent.pointerOut(tab(), {
      relatedTarget: screen.getByTestId("elsewhere"),
    });
    fireEvent.pointerOver(tab(), { clientX: 14, clientY: 10 });
    await wait(700);
    expect(card()?.textContent).toBe("Events: 5");
  });
});

describe("where the card sits", () => {
  const rect = (top: number, height: number, width = 80) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: width,
      width,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  const placed = async (rowTop: number, pointerY: number) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "tooltip"
          ? rect(0, 22)
          : rect(rowTop, 24);
      }
    );
    fireEvent.pointerOver(tab(), { clientX: 40, clientY: pointerY });
    await wait(700);
    const shown = card() as HTMLElement;
    return { top: parseFloat(shown.style.top), side: shown.dataset.side };
  };

  afterEach(() => vi.restoreAllMocks());

  /**
   * Dana's Restarts card sat over the row above the hovered one and hid its
   * cell. Fails if the card is drawn above a row that has room below it.
   */
  it("goes below the hovered row and the pointer, not over the row above", async () => {
    const { top, side } = await placed(300, 316);
    expect(side).toBe("bottom");
    expect(top).toBeGreaterThanOrEqual(324);
    expect(top).toBeGreaterThanOrEqual(316 + 20);
  });

  /** Fails if a row at the window's foot pushes its card off screen instead of flipping it above. */
  it("flips above a row with no room left below it", async () => {
    const { top, side } = await placed(
      window.innerHeight - 30,
      window.innerHeight - 20
    );
    expect(side).toBe("top");
    expect(top + 22).toBeLessThanOrEqual(window.innerHeight - 30);
  });
});
