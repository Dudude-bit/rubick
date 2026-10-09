import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { AddressesCell } from "@/routes/c/$cluster/(network)/endpoints/-components/EndpointAddresses";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Hovers a trigger the way a mouse does, and waits out the open delay. */
async function hover(trigger: HTMLElement) {
  fireEvent.pointerMove(trigger, { pointerType: "mouse" });
  await wait(700);
}

describe("a tooltip and the pointer", () => {
  /**
   * Dana moved off the link note and its tooltip stayed above the status bar
   * for the note's remaining 12 to 15 s: the card waited for a pointer move
   * that never came at the window's edge. Fails if leaving the trigger no
   * longer closes it.
   */
  it("leaves with the pointer", async () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>3 UI stalls</TooltipTrigger>
          <TooltipContent>The main thread stalled</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    const trigger = screen.getByRole("button", { name: "3 UI stalls" });
    await hover(trigger);
    expect(screen.getAllByText("The main thread stalled")).not.toHaveLength(0);

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    expect(screen.queryByText("The main thread stalled")).toBeNull();
  });

  /** The addresses in an Endpoints tooltip are copied from inside it; fails if the card closes before the pointer can reach them. */
  it("waits for the pointer where the card holds something to click", async () => {
    render(
      <TooltipProvider>
        <AddressesCell
          addresses={[
            {
              address: {
                ip: "10.0.0.7",
                hostname: null,
                nodeName: null,
                targetRef: null,
              },
              ready: true,
            },
          ]}
        />
      </TooltipProvider>
    );
    const trigger = screen.getByRole("button", { name: "1" });
    await hover(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    expect(screen.getAllByText("10.0.0.7")).not.toHaveLength(0);
  });
});
