import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

const vendor = vi.hoisted(() => ({
  terminated: null as boolean | null,
}));
vi.mock("@/hooks/useIngressTls", () => ({
  useIngressTls: () => ({
    available: true,
    of: (_: unknown, host: string) => ({
      host,
      terminated: vendor.terminated,
      by: { key: "verbatimLine", values: { said: "shop-cert" } },
    }),
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/lib/commands", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => null) }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { useResourceDetail } from "@/hooks";
import type { IngressInfo } from "@/generated/types";
import { IngressDetail } from "./IngressDetail";

const shop: IngressInfo = {
  name: "shop",
  namespace: "web",
  className: "gce",
  rules: [
    {
      host: "shop.example.com",
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: "storefront",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  defaultBackend: null,
  loadBalancerIps: ["34.1.2.3"],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  labels: {},
  annotations: {},
  createdAt: null,
};

const open = (tab: string) => {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "shop",
    namespace: "web",
    resource: shop,
    isLoading: false,
    error: null,
    yaml: "",
    copyYaml: vi.fn(),
    activeTab: tab,
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <IngressDetail />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  vendor.terminated = null;
});

describe("an Ingress whose certificate the controller could not read", () => {
  /**
   * The page took "could not tell" for silence and let an empty `spec.tls`
   * decide: "no TLS" in the header and an `http://` URL on the Access tab,
   * for a host GKE serves over HTTPS. Fails if `null` is read as `false`.
   */
  it("says TLS was not checked and offers no scheme", () => {
    open("access");

    expect(screen.queryByText("no TLS")).toBeNull();
    expect(screen.getAllByText("TLS not checked").length).toBeGreaterThan(0);
    expect(screen.queryByText("HTTP")).toBeNull();
    expect(screen.queryByText("HTTPS")).toBeNull();
    expect(screen.queryByLabelText("Open in Browser")).toBeNull();
  });

  /** The other side of the same branch: a controller that said no. */
  it("says no TLS when the controller said it serves plain HTTP", () => {
    vendor.terminated = false;
    open("access");

    expect(screen.getAllByText("no TLS").length).toBeGreaterThan(0);
    expect(screen.getByText("HTTP")).toBeTruthy();
    expect(screen.getByLabelText("Open in Browser")).toBeTruthy();
  });
});
