import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    getResourceConnections: vi.fn(async () => connections.answer),
  },
}));

const connections = vi.hoisted(() => ({ answer: null as unknown }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useClusterStore } from "@/stores/clusterStore";
import { usePinnedServicesStore } from "@/stores/pinnedServicesStore";
import { MyServices } from "./MyServices";

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <MyServices />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
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
  it("shows nothing that was not pinned by hand", () => {
    usePinnedServicesStore.setState({ pins: [pin("payments")] });
    mount();

    expect(screen.getAllByTestId("service-card")).toHaveLength(1);
    expect(screen.getByText("payments")).toBeInTheDocument();
  });

  it("shows a cluster none of whose services are pinned how to start", () => {
    usePinnedServicesStore.setState({ pins: [pin("payments", "staging")] });
    mount();

    expect(screen.queryByTestId("service-card")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is pinned in this cluster/)
    ).toBeInTheDocument();
  });

  it("leaves the other cluster's pins on the other cluster", () => {
    usePinnedServicesStore.setState({
      pins: [pin("payments", "prod"), pin("carts", "staging")],
    });
    mount();

    expect(screen.getByText("payments")).toBeInTheDocument();
    expect(screen.queryByText("carts")).not.toBeInTheDocument();
  });

  it("draws them in the order they were pinned", () => {
    usePinnedServicesStore.setState({
      pins: [
        { ...pin("second"), pinnedAt: 2 },
        { ...pin("first"), pinnedAt: 1 },
      ],
    });
    mount();

    const names = screen
      .getAllByTestId("service-card")
      .map((card) => card.querySelector("a")?.textContent);
    expect(names).toEqual(["first", "second"]);
  });
});
