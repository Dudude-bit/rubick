import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/commands", () => ({
  commands: {
    getResourceConnections: vi.fn(async () => connections.answer),
  },
}));

const connections = vi.hoisted(() => ({ answer: null as unknown }));

import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";
import { usePinnedServicesStore } from "@/stores/pinnedServicesStore";
import { MyServices } from "./MyServices";

function mount() {
  return renderWithRouter(<MyServices />, {
    at: "/c/prod",
    route: "/c/$cluster",
  });
}

beforeEach(() => {
  usePinnedServicesStore.setState({ pins: [] });
  useClusterStore.setState({ currentContext: "prod" });
  connections.answer = null;
});

const pin = (name: string, context = "prod") => ({
  context,
  kind: "Deployment",
  namespace: "shop",
  name,
  pinnedAt: 1,
});

describe("My services", () => {
  /**
   * The one rule of this page. Anything that arrives here without somebody
   * pressing Pin — a recently opened object, a label convention, a heuristic
   * about what looks important — makes the list something to double-check
   * rather than something to trust.
   */
  it("shows nothing that was not pinned by hand", async () => {
    usePinnedServicesStore.setState({ pins: [pin("payments")] });
    await mount();

    expect(screen.getAllByTestId("service-card")).toHaveLength(1);
    expect(screen.getByText("payments")).toBeInTheDocument();
  });

  /**
   * Lena met "Pin" before she knew the verb. Fails if the empty card stops
   * saying what pinning gives, or loses the way to a workload to pin.
   */
  it("shows a cluster none of whose services are pinned how to start", async () => {
    usePinnedServicesStore.setState({ pins: [pin("payments", "staging")] });
    const { router } = await mount();

    expect(screen.queryByTestId("service-card")).not.toBeInTheDocument();
    expect(
      screen.getByText(/to keep its readiness and last change here/)
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("link", { name: "Find one to pin" })
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/c/prod/deployments")
    );
  });

  it("leaves the other cluster's pins on the other cluster", async () => {
    usePinnedServicesStore.setState({
      pins: [pin("payments", "prod"), pin("carts", "staging")],
    });
    await mount();

    expect(screen.getByText("payments")).toBeInTheDocument();
    expect(screen.queryByText("carts")).not.toBeInTheDocument();
  });

  it("draws them in the order they were pinned", async () => {
    usePinnedServicesStore.setState({
      pins: [
        { ...pin("second"), pinnedAt: 2 },
        { ...pin("first"), pinnedAt: 1 },
      ],
    });
    await mount();

    const names = screen
      .getAllByTestId("service-card")
      .map((card) => card.querySelector("a")?.textContent);
    expect(names).toEqual(["first", "second"]);
  });
});
