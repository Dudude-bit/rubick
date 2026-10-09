import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { EventInfo } from "@/generated/types";
import type { ObjectEventsQuery } from "@/hooks/useObjectEvents";
import { renderWithRouter } from "@/test/render";
import { ObjectEventsBody } from "./ObjectEventsBody";

const about = (pod: string, reason: string, at: number): EventInfo => ({
  name: `${pod}.${reason}`,
  namespace: "shop",
  uid: `${pod}-${reason}`,
  type: "Normal",
  reason,
  message: `${reason}, number ${at}`,
  source: null,
  involvedObject: { kind: "Pod", name: pod, namespace: "shop", uid: null },
  count: 1,
  firstTimestamp: null,
  lastTimestamp: new Date(Date.UTC(2026, 9, 9, 10, 0, at)).toISOString(),
});

const answered = (data: EventInfo[]) =>
  ({
    data,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  }) as unknown as ObjectEventsQuery;

const body = (data: EventInfo[]) => (
  <ObjectEventsBody query={answered(data)} everyObject={false} />
);

const reasons = () =>
  screen.getAllByText(/, number /).map((message) => message.textContent);

describe("one object's events, live", () => {
  /**
   * A newest-first list moves every row down when an event arrives, so a
   * click aimed at one lands on another. Fails if a new answer moves the
   * rows while the pointer is on them, or what arrived cannot be reached.
   */
  it("holds its rows while the pointer is on them and offers what arrived", async () => {
    const first = [about("web-1", "Started", 2), about("web-1", "Pulled", 1)];
    const { rerender } = await renderWithRouter(body(first));
    await userEvent.hover(screen.getByText("Started, number 2"));

    await rerender(body([about("web-1", "Killing", 3), ...first]));
    expect(reasons()).toEqual(["Started, number 2", "Pulled, number 1"]);

    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 update" })
    );
    expect(reasons()).toEqual([
      "Killing, number 3",
      "Started, number 2",
      "Pulled, number 1",
    ]);
  });

  /**
   * A link inside the list opens another object with the pointer still on
   * it. Fails if the rows held for one object are drawn under another's.
   */
  it("draws another object's events at once, pointer or not", async () => {
    const { rerender } = await renderWithRouter(
      body([about("web-1", "Started", 2)])
    );
    await userEvent.hover(screen.getByText("Started, number 2"));

    await rerender(body([about("api-2", "Pulled", 5)]));
    expect(reasons()).toEqual(["Pulled, number 5"]);
    expect(
      screen.queryByRole("button", { name: /Show \d+ update/ })
    ).toBeNull();
  });
});
