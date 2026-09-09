/**
 * The overview needs a cluster-wide read, and an RBAC-scoped user does not
 * have it. That refusal must read as a refusal — no permission, pick your
 * namespaces — and never as the raw "Could not read cluster state" fault with
 * a retry that will be refused the same way. Deleting the `isRefusal` branch
 * puts the reported screenshot (a Tauri error dump on Overview) back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    getClusterOverview: vi.fn(),
    getClusterInfo: vi.fn(async () => null),
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { ClusterOverview } from "./ClusterOverview";

const getClusterOverview = vi.mocked(commands.getClusterOverview);

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ClusterOverview />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  getClusterOverview.mockReset();
  useClusterStore.setState({
    isConnected: true,
    currentContext: "",
    namespaceScope: [],
  });
});

describe("what the overview does when the read is refused", () => {
  it("names the refusal and offers no retry when the cluster forbids the read", async () => {
    getClusterOverview.mockRejectedValue(
      'Tauri command \'getClusterOverview\' failed: pods is forbidden: User "kc" cannot list resource "pods" in API group "" at the cluster scope: Forbidden (code: 403)'
    );

    mount();

    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to read the whole cluster/i)
      ).toBeInTheDocument()
    );
    // A refusal will not change on a retry, so the button that invites one is
    // gone.
    expect(
      screen.queryByRole("button", { name: /retry/i })
    ).not.toBeInTheDocument();
    // The fault headline is the wrong words for a refusal.
    expect(
      screen.queryByText("Could not read cluster state")
    ).not.toBeInTheDocument();
    // And the framing prefix the reporter saw is off the message.
    expect(screen.queryByText(/Tauri command/)).not.toBeInTheDocument();
  });

  it("keeps the fault headline and a retry when the read fails for any other reason", async () => {
    getClusterOverview.mockRejectedValue(
      "Tauri command 'getClusterOverview' failed: error trying to connect: connection refused"
    );

    mount();

    await waitFor(() =>
      expect(
        screen.getByText("Could not read cluster state")
      ).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(
      screen.queryByText(/do not have permission to read the whole cluster/i)
    ).not.toBeInTheDocument();
  });
});
