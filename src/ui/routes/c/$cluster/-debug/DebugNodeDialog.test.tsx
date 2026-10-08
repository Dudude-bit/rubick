import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AccessQuery } from "@/generated/types";

const checkAccess = vi.hoisted(() => vi.fn());
const startNodeDebug = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({ commands: { checkAccess } }));
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/hooks", () => ({
  useDebugOperation: () => ({
    state: "idle",
    operation: null,
    startNodeDebug,
    cancel: vi.fn(),
    continueWaiting: vi.fn(),
  }),
}));

const { DebugNodeDialog } = await import("./DebugNodeDialog");
const { renderWithProviders } = await import("@/test/render");
const { marcoReview } = await import("@/test/marco");
const { useClusterStore } = await import("@/stores/clusterStore");

beforeEach(() => {
  checkAccess.mockReset();
  startNodeDebug.mockReset();
  useClusterStore.setState((s) => ({
    currentContext: "acme-staging",
    contexts: [],
    namespaceScope: ["team-checkout"],
    isConnected: true,
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
});

function open() {
  return renderWithProviders(
    <DebugNodeDialog
      open
      onOpenChange={() => {}}
      nodeName="node01"
      onDebugStart={() => {}}
    />
  );
}

const start = () => screen.getByRole("button", { name: "Start Debug" });
const namespaceField = () =>
  screen.getByRole("textbox", { name: "Debug Pod Namespace" });

describe("DebugNodeDialog where the cluster refuses this user", () => {
  /**
   * Marco opened Debug node from a Node peek and got a live red Start Debug,
   * though can-i create pods says no in every namespace he has. Fails if
   * Start reads as runnable, says nothing, or reaches the cluster.
   */
  it("greys Start Debug with the can-i question and starts nothing", async () => {
    checkAccess.mockImplementation(marcoReview);
    open();

    await waitFor(() =>
      expect(start()).toHaveAttribute("aria-disabled", "true")
    );
    expect(
      screen.getByText(/can-i create pods -n team-checkout\./)
    ).toBeInTheDocument();
    fireEvent.click(start());
    expect(startNodeDebug).not.toHaveBeenCalled();
  });

  /**
   * The pod lands in the namespace typed into the field, so that is the one
   * to ask about. Fails if the answer for the first namespace sticks after
   * the reader names one the cluster allows.
   */
  it("asks again for the namespace typed and starts there once allowed", async () => {
    checkAccess.mockImplementation(async (queries: AccessQuery[]) =>
      queries.map((query) => ({
        ...query,
        allowed: query.namespace === "sandbox",
      }))
    );
    open();
    await waitFor(() =>
      expect(start()).toHaveAttribute("aria-disabled", "true")
    );

    fireEvent.change(namespaceField(), { target: { value: "sandbox" } });
    await waitFor(() => expect(start()).not.toHaveAttribute("aria-disabled"), {
      timeout: 2000,
    });
    fireEvent.click(start());
    await waitFor(() =>
      expect(startNodeDebug).toHaveBeenCalledWith(
        "node01",
        "sandbox",
        expect.objectContaining({ image: "busybox:latest" })
      )
    );
  });

  /**
   * A pod that can be created but never entered is a privileged pod left
   * running on the node for an hour. Fails if a refused exec leaves Start live.
   */
  it("greys Start Debug when the pod could be created but not entered", async () => {
    checkAccess.mockImplementation(async (queries: AccessQuery[]) =>
      queries.map((query) => ({ ...query, allowed: !query.subresource }))
    );
    open();

    await waitFor(() =>
      expect(start()).toHaveAttribute("aria-disabled", "true")
    );
    expect(
      screen.getByText(/can-i create pods\/exec -n team-checkout\./)
    ).toBeInTheDocument();
  });
});

describe("DebugNodeDialog's namespace", () => {
  /** Fails if the field ignores the namespace in view and says default. */
  it("opens on the namespace in view", () => {
    checkAccess.mockImplementation(marcoReview);
    open();
    expect(namespaceField()).toHaveValue("team-checkout");
  });

  /** Fails if a window on every namespace ignores the kubeconfig's namespace. */
  it("opens on the kubeconfig context's namespace, else on default", () => {
    checkAccess.mockImplementation(marcoReview);
    useClusterStore.setState({
      namespaceScope: [],
      contexts: [
        {
          name: "acme-staging",
          namespace: "team-checkout",
        } as never,
      ],
    });
    const { unmount } = open();
    expect(namespaceField()).toHaveValue("team-checkout");
    unmount();

    useClusterStore.setState({ contexts: [] });
    open();
    expect(namespaceField()).toHaveValue("default");
  });

  /** The image picker said "debugBusybox", the catalogue key, not its name. */
  it("names the image in words rather than by its catalogue key", () => {
    checkAccess.mockImplementation(marcoReview);
    open();
    expect(
      screen.getByRole("combobox", { name: "Debug Image" })
    ).toHaveTextContent("BusyBox (minimal)");
  });
});
