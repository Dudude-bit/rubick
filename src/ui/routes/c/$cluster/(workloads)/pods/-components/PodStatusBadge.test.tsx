import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, render, screen } from "@testing-library/react";

import { useWindowActivity } from "@/lib/window-activity";
import { PodStatusBadge } from "./PodStatusBadge";

beforeEach(() => {
  vi.useFakeTimers();
  useWindowActivity.setState({
    visible: true,
    focused: true,
    interactionAt: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PodStatusBadge", () => {
  /**
   * The Overview counts a pod Pending in amber the moment its wait runs
   * out; the list and the page header redrew only when the pod next
   * changed, and an unplaced pod does not change. Fails if the badge waits
   * for a new read to turn.
   */
  it("turns amber when the pod's wait runs out, with nothing read again", async () => {
    const pod = {
      status: { display: "Pending", phase: "Pending" },
      start: {
        state: "starting" as const,
        until: new Date(Date.now() + 5_000).toISOString(),
      },
      containers: [],
      initContainers: [],
    };
    render(<PodStatusBadge pod={pod} silence={null} />);
    expect(screen.getByText("Pending").className).toContain("text-info");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText("Pending").className).toContain("text-warn");
  });
});
