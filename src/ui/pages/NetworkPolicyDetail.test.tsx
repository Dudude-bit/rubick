import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => null) }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useResourceDetail } from "@/hooks";
import type { NetworkPolicyInfo } from "@/generated/types";
import { NetworkPolicyDetail } from "./NetworkPolicyDetail";

const policy = (selected: number | null): NetworkPolicyInfo => ({
  name: "p",
  namespace: "shop",
  selects: { kind: "everything" },
  selected,
  ingress: {
    governed: true,
    rules: [],
    opensToEverything: false,
    deniesEverything: true,
  },
  egress: {
    governed: false,
    rules: [],
    opensToEverything: false,
    deniesEverything: false,
  },
  labels: {},
  createdAt: null,
});

/** The colour the page paints the policy's pod reach in. */
function reachColour(selected: number | null, words: string): string {
  cleanup();
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "p",
    namespace: "shop",
    resource: policy(selected),
    isLoading: false,
    error: null,
    yaml: "",
    copyYaml: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <TooltipProvider>
          <NetworkPolicyDetail />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const drawn = screen.getByText(words, { selector: "dd, dd *" });
  const painted = drawn.closest("[class*='text-']");
  return /text-(?:fg(?:-\w+)?|warn|err|ok|info)\b/.exec(
    painted?.className ?? ""
  )![0];
}

describe("the pods a NetworkPolicy's page says it selects", () => {
  /**
   * "pods not read" was drawn in the colour of a count, the words the only
   * difference between a refused pod list and one that was read.
   */
  it("paints a pod list it could not read apart from a count and from none", () => {
    const refused = reachColour(null, "pods not read");
    expect(refused).not.toBe(reachColour(3, "3 pods"));
    expect(refused).not.toBe(reachColour(0, "no pods"));
  });
});
