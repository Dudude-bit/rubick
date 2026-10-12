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

  /**
   * A filter narrowing the feed turns a quiet story from done into cannot
   * say with nothing else on the card moving. Fails if the card is held over
   * a state it no longer has.
   */
  it("draws the story's new state when a filter narrows the feed under it", async () => {
    const started: EventInfo = {
      ...backOff,
      type: "Normal",
      reason: "Started",
      message: "Started container app",
    };
    const whole: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
    };
    const narrowed: StoryOptions = { ...whole, narrowed: true };
    const [done] = storiesOf([started], whole);
    const { rerender } = await renderWithRouter(
      <StoryCard story={done} options={whole} showNamespace={false} />
    );
    expect(screen.getByText("done")).toBeInTheDocument();

    const [unsure] = storiesOf([started], narrowed);
    rerender(
      <StoryCard story={unsure} options={narrowed} showNamespace={false} />
    );
    expect(screen.getByText("cannot say")).toBeInTheDocument();
  });
});

describe("a story about an earlier object of a name", () => {
  /**
   * A link from the old wd-demo's FailedMount opened the pod made again under
   * the name, as if the warning were its own. Fails if the card links or
   * peeks the name, or stops saying the object was an earlier one.
   */
  it("names the object without a link and says it was an earlier one", async () => {
    const earlier: EventInfo = {
      ...backOff,
      reason: "FailedMount",
      involvedObject: { ...backOff.involvedObject, uid: "d10287fd" },
    };
    const options: StoryOptions = {
      now: NOW,
      windowMs: HOUR,
      narrowed: false,
      readFrom: null,
      earlier: new Set(["d10287fd"]),
    };
    const [story] = storiesOf([earlier], options);
    const { container } = await renderWithRouter(
      <StoryCard story={story} options={options} showNamespace={false} />
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("earlier object")).toBeInTheDocument();
    expect(container.querySelector("[data-past='earlier']")).toHaveAttribute(
      "title",
      expect.stringContaining("earlier Pod named web-0")
    );
  });
});
