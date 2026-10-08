import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type { EventInfo } from "@/generated/types";
import { storiesOf, WINDOW_MS, type StoryOptions } from "@/lib/event-stories";
import { renderWithRouter } from "@/test/render";
import { StoryCard } from "./StoryCard";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const HOUR = WINDOW_MS["1h"];

const backOff: EventInfo = {
  name: "web-0.1",
  namespace: "shop",
  uid: "web-0.1",
  type: "Warning",
  reason: "BackOff",
  message: "Back-off restarting failed container app",
  source: "kubelet",
  involvedObject: { kind: "Pod", name: "web-0", namespace: "shop", uid: null },
  count: 3,
  firstTimestamp: new Date(NOW - 120_000).toISOString(),
  lastTimestamp: new Date(NOW - 60_000).toISOString(),
};

const unreadSlices = () =>
  screen.getByRole("img").querySelectorAll(".border-dashed").length;

describe("a story card held between watch ticks", () => {
  /**
   * The card skips a redraw when its own events did not change. Fails if a
   * pool cut at the limit moving its oldest row past a slice of the strip
   * leaves that slice drawn as quiet instead of unread.
   */
  it("draws the slices the read stopped short of as unread when only the read's reach moved", async () => {
    const whole: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const [story] = storiesOf([backOff], whole);
    const { rerender } = await renderWithRouter(
      <StoryCard story={story} options={whole} showNamespace={false} />
    );
    expect(unreadSlices()).toBe(0);

    const cut: StoryOptions = { ...whole, readFrom: NOW - HOUR / 2 };
    rerender(<StoryCard story={story} options={cut} showNamespace={false} />);
    expect(unreadSlices()).toBe(12);
  });
});
