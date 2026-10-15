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
   * A pod whose kubelet cannot mount a missing Secret led its page with that
   * in red beside a blue badge saying it was coming. Fails if the warnings,
   * once read, leave the badge blue, or if it turns amber without them.
   */
  it("turns amber inside its wait once its kubelet's warnings say it is not coming", () => {
    const pod = {
      status: { display: "ContainerCreating", phase: "Pending" },
      start: {
        state: "starting" as const,
        until: new Date(Date.now() + 300_000).toISOString(),
      },
      containers: [],
      initContainers: [],
    };
    const { rerender } = render(<PodStatusBadge pod={pod} silence={null} />);
    expect(screen.getByText("ContainerCreating").className).toContain(
      "text-info"
    );
    rerender(
      <PodStatusBadge pod={{ ...pod, kubeletWarned: true }} silence={null} />
    );
    expect(screen.getByText("ContainerCreating").className).toContain(
      "text-warn"
    );
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

  /**
   * Dana's recommendations pods, turned away by the kubelet at admission,
   * said on hover that the node removed them for memory or disk: an
   * eviction's words about pods that never ran. Fails if such a pod's hover
   * loses the kubelet's own words or keeps the eviction's.
   */
  it("says on hover what the kubelet said when it turned a pod away", () => {
    const said = "Pod was rejected: The node had condition: [DiskPressure].";
    render(
      <PodStatusBadge
        pod={{
          status: { display: "Evicted", phase: "Failed", rejected: said },
          containers: [],
          initContainers: [],
        }}
        silence={null}
      />
    );
    const title =
      screen.getByText("Evicted").closest("[title]")?.getAttribute("title") ??
      "";
    expect(title).toContain(`never ran. It said: ${said}`);
    expect(title).not.toContain("ran short of memory or disk");
  });
});
