import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { renderWithProviders } from "@/test/render";
import { toastWriteError } from "@/lib/toast-error";
import { useClusterStore } from "@/stores/clusterStore";
import { useWriteLog } from "@/stores/writeLogStore";
import { WritesTab } from "./WritesTab";

vi.mock("@/components/ui/use-toast", () => ({ toast: vi.fn() }));

const failure = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

afterEach(() => useWriteLog.setState({ records: [] }));

describe("the Writes tab", () => {
  /**
   * A refused restart left a toast and nothing else, so a reader who looked
   * away found no trace of it. Fails if a failed write is not kept with the
   * dialog's own lead words and the lock a refusal wears.
   */
  it("keeps a refused write with its lead words and a lock", async () => {
    useClusterStore.setState({ currentContext: "gke" });
    toastWriteError(
      "Could not restart api",
      failure("PERMISSION_DENIED", "deployments.apps is forbidden")
    );
    const { container } = await renderWithProviders(<WritesTab />);

    expect(screen.getByText("Could not restart api")).toBeInTheDocument();
    expect(
      screen.getByText(/The cluster refused it: deployments.apps is forbidden/)
    ).toBeInTheDocument();
    expect(container.querySelector(".lucide-lock")).not.toBeNull();
  });

  /**
   * "Failed" is a verdict on a write nobody saw end. Fails if an unanswered
   * write is kept under the failure words, or without its hourglass.
   */
  it("keeps an unanswered write as unanswered, not failed", async () => {
    useClusterStore.setState({ currentContext: "gke" });
    toastWriteError(
      "Could not scale api",
      failure("READ_DEADLINE", "no answer in 30 s")
    );
    const { container } = await renderWithProviders(<WritesTab />);

    expect(screen.queryByText(/It did not go through/)).toBeNull();
    expect(container.querySelector("[data-outcome=unanswered]")).not.toBeNull();
    expect(container.querySelector(".lucide-hourglass")).not.toBeNull();
  });

  /** Fails if the same error reaching the toast and the dialog is listed twice. */
  it("lists one error once however many surfaces report it", async () => {
    useClusterStore.setState({ currentContext: "gke" });
    const error = failure("KUBE_API_ERROR", "conflict");
    toastWriteError("Could not delete api", error);
    toastWriteError("Delete api?", error);
    await renderWithProviders(<WritesTab />);

    expect(useWriteLog.getState().records).toHaveLength(1);
  });

  /** Fails if another cluster's failed write is listed under this one's name. */
  it("lists only the failures of the cluster on screen", async () => {
    useClusterStore.setState({ currentContext: "gke" });
    toastWriteError("Could not delete api", failure("KUBE_API_ERROR", "x"));
    useClusterStore.setState({ currentContext: "k3d" });
    await renderWithProviders(<WritesTab />);

    expect(screen.getByText("No write has failed")).toBeInTheDocument();
    act(() => useClusterStore.setState({ currentContext: "gke" }));
    expect(await screen.findByText("Could not delete api")).toBeInTheDocument();
  });
});
