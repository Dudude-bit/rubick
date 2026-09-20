import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({ commands: {} }));
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/hooks", () => ({
  useDebugOperation: () => ({
    isPolling: false,
    operation: null,
    startEphemeralContainer: vi.fn(),
    startCopyPod: vi.fn(),
    cancel: vi.fn(),
    continueWaiting: vi.fn(),
    stopWaiting: vi.fn(),
  }),
}));

const { DebugPodDialog } = await import("./DebugPodDialog");

function open(props: Partial<Parameters<typeof DebugPodDialog>[0]> = {}) {
  return render(
    <DebugPodDialog
      open
      onOpenChange={() => {}}
      podName="left-behind"
      namespace="k8s-gui-test"
      containers={[]}
      kubernetesVersion="v1.31.0"
      onDebugStart={() => {}}
      {...props}
    />
  );
}

describe("DebugPodDialog", () => {
  /**
   * The dialog is mounted with the pod, before the pod's container list has
   * arrived, so a default frozen in `useState` was decided against an empty
   * list: Target Container came up blank and stayed blank however the dialog
   * was opened. It has to be derived, so a list that arrives late is used.
   */
  it("names a target container even when the list arrives after it is mounted", () => {
    const { rerender } = open();
    rerender(
      <DebugPodDialog
        open
        onOpenChange={() => {}}
        podName="left-behind"
        namespace="k8s-gui-test"
        containers={["pause"]}
        kubernetesVersion="v1.31.0"
        onDebugStart={() => {}}
      />
    );
    expect(
      screen.getByRole("combobox", { name: /target container/i })
    ).toHaveTextContent("pause");
  });

  /** The Files tab opens this for one named container; that one must be chosen. */
  it("prefers the container the caller named over the first one", () => {
    open({ containers: ["app", "sidecar"], preferredTarget: "sidecar" });
    expect(
      screen.getByRole("combobox", { name: /target container/i })
    ).toHaveTextContent("sidecar");
  });

  /** A name the pod does not have is not a container; the real list wins. */
  it("ignores a preferred container the pod does not have", () => {
    open({ containers: ["app"], preferredTarget: "gone" });
    expect(
      screen.getByRole("combobox", { name: /target container/i })
    ).toHaveTextContent("app");
  });
});
