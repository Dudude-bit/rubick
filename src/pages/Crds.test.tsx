/**
 * A failed read leaves the CRD list empty exactly as a cluster with no CRDs
 * does, and the page said "This cluster has no custom resource definitions."
 * for both. One is an answer; the other is that nobody could look — and
 * since every read got a deadline, the second is routine rather than
 * theoretical. The page never took `error` off its query at all.
 */

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/lib/commands", () => ({
  commands: { listCrds: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { Crds } from "./Crds";

const listCrds = vi.mocked(commands.listCrds);

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/customresourcedefinitions"]}>
        <TooltipProvider>{children}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(<Crds />, { wrapper });
}

beforeEach(() => {
  listCrds.mockReset();
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

describe("the CRD list when the read did not answer", () => {
  it("does not call a read that ran out of time an empty cluster", async () => {
    listCrds.mockRejectedValue(
      new Error("READ_DEADLINE: the cluster did not answer within 60 s")
    );
    draw();
    await waitFor(() => {
      expect(screen.getByText(/could not read/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/has no custom resource definitions/i)
    ).toBeNull();
  });

  it("says a refusal is a refusal, not a failure to retry into", async () => {
    listCrds.mockRejectedValue(
      new Error("customresourcedefinitions is forbidden (code: 403)")
    );
    draw();
    await waitFor(() => {
      expect(
        screen.getByText(/do not have permission to list/i)
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/has no custom resource definitions/i)
    ).toBeNull();
  });

  it("still says the cluster has none when that is the answer", async () => {
    listCrds.mockResolvedValue([]);
    draw();
    await waitFor(() => {
      expect(
        screen.getByText(/has no custom resource definitions/i)
      ).toBeInTheDocument();
    });
  });
});
