import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
import type { ConditionInfo, GatewayInfo } from "@/generated/types";
import { GatewayDetail } from "./GatewayDetail";

const said = (type: string, status: string, reason: string): ConditionInfo => ({
  type,
  status,
  reason,
  message: null,
  lastTransitionTime: null,
});

const edge = (listener: ConditionInfo[]): GatewayInfo => ({
  name: "edge",
  namespace: "infra",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "istio",
  listenerSets: [],
  listenerSetsKnown: true,
  listeners: [
    {
      name: "https",
      port: 443,
      protocol: "HTTPS",
      hostname: null,
      tlsMode: null,
      certificateRefs: [],
      allowedNamespaces: null,
      attachedRoutes: 1,
      conditions: listener,
      fromListenerSet: null,
    },
  ],
  addresses: [],
  conditions: [said("Programmed", "True", "Programmed")],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
});

const open = (gateway: GatewayInfo) => {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "edge",
    namespace: "infra",
    resource: gateway,
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
          <GatewayDetail />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe("a Gateway's listener rows", () => {
  /**
   * Any False read as broken, so an Istio listener that reported
   * `Conflicted=False · NoConflicts` sat on the page in red — the same
   * reading the peek had, fixed in both.
   */
  it("reads a listener's conditions by their own polarity", () => {
    open(
      edge([
        said("Accepted", "True", "Accepted"),
        said("Conflicted", "False", "NoConflicts"),
      ])
    );
    expect(screen.queryByText(/NoConflicts/)).toBeNull();
  });

  it("still names the condition that broke it", () => {
    open(edge([said("ResolvedRefs", "False", "InvalidCertificateRef")]));
    expect(screen.getByText(/InvalidCertificateRef/)).toBeTruthy();
  });
});
