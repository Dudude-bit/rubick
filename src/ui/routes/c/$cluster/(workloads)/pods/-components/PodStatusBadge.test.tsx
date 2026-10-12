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

  /**
   * Dana's Pods list drew evicted pods grey `ContainerStatusUnknown` while
   * the page, peek and Needs attention said red `Evicted`. Fails if a failed
   * pod's badge reads grey, or kubectl's other word is not on its hover.
   */
  it("draws a failed pod red with kubectl's word on its hover", () => {
    const failed = (display: string, kubectlStatus?: string) => ({
      status: { display, phase: "Failed", kubectlStatus },
      containers: [],
      initContainers: [],
    });
    const { unmount } = render(
      <PodStatusBadge
        pod={failed("Evicted", "Init:ContainerStatusUnknown")}
        silence={null}
      />
    );
    const evicted = screen.getByText("Evicted");
    expect(evicted.className).toContain("text-err");
    expect(evicted.closest("[title]")?.getAttribute("title")).toContain(
      "kubectl get pods prints Init:ContainerStatusUnknown"
    );
    unmount();

    render(
      <PodStatusBadge pod={failed("ContainerStatusUnknown")} silence={null} />
    );
    expect(screen.getByText("ContainerStatusUnknown").className).toContain(
      "text-err"
    );
  });
});
