import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AccessQuery } from "@/generated/types";

const checkAccess = vi.hoisted(() => vi.fn());
const startEphemeral = vi.hoisted(() => vi.fn());
const startCopyPod = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({ commands: { checkAccess } }));
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/hooks", () => ({
  useDebugOperation: () => ({
    state: "idle",
    operation: null,
    startEphemeral,
    startCopyPod,
    cancel: vi.fn(),
    continueWaiting: vi.fn(),
  }),
}));

const { DebugPodDialog } = await import("./DebugPodDialog");
const { renderWithProviders } = await import("@/test/render");
const { marcoReview, marcoMay } = await import("@/test/marco");
const { useClusterStore } = await import("@/stores/clusterStore");

beforeEach(() => {
  checkAccess.mockReset();
  startEphemeral.mockReset();
  startCopyPod.mockReset();
  useClusterStore.setState((s) => ({
    currentContext: "acme-staging",
    isConnected: true,
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
});

function open(props: Partial<Parameters<typeof DebugPodDialog>[0]> = {}) {
  return renderWithProviders(
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

const start = () => screen.getByRole("button", { name: "Start Debug" });

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

describe("DebugPodDialog where the cluster refuses this user", () => {
  /**
   * Marco reached the dialog from checkout-api's row and Start Debug was
   * live, though can-i patch pods/ephemeralcontainers and can-i create pods
   * both say no. Fails if either way reads as open or Start reaches the
   * cluster.
   */
  it("says why each way is shut and starts nothing", async () => {
    checkAccess.mockImplementation(marcoReview);
    open({
      podName: "checkout-api-6767fbfdb7-blpfk",
      namespace: "team-checkout",
      containers: ["api"],
    });

    await waitFor(() =>
      expect(start()).toHaveAttribute("aria-disabled", "true")
    );
    expect(
      screen.getByText(/can-i patch pods\/ephemeralcontainers -n team-checkout/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/can-i create pods -n team-checkout/)
    ).toBeInTheDocument();
    fireEvent.click(start());
    expect(startEphemeral).not.toHaveBeenCalled();
    expect(startCopyPod).not.toHaveBeenCalled();
  });

  /**
   * A reader the cluster lets create pods but not add ephemeral containers
   * has one way in. Fails if the dialog opens on the refused way, or greys
   * the one that works.
   */
  it("opens on the way the cluster allows", async () => {
    checkAccess.mockImplementation(async (queries: AccessQuery[]) =>
      queries.map((query) => ({
        ...query,
        allowed:
          (query.verb === "create" && !query.subresource) || marcoMay(query),
      }))
    );
    open({ namespace: "team-checkout", containers: ["api"] });

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Copy Pod/ })).toBeChecked()
    );
    expect(screen.getByRole("radio", { name: /Ephemeral/ })).toBeDisabled();
    expect(start()).not.toHaveAttribute("aria-disabled");
    fireEvent.click(start());
    await waitFor(() => expect(startCopyPod).toHaveBeenCalled());
  });
});
