import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { IngressInfo } from "@/generated/types";

const answers = vi.hoisted(() => ({
  backing: (): Promise<unknown> => Promise.resolve({}),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: () => Promise.resolve([shop]),
    listCustomResources: () => Promise.resolve([]),
    resolveIngressClass: () =>
      Promise.resolve({
        requested: null,
        resolved: null,
        controller: null,
        viaDefault: false,
        available: [
          {
            name: "nginx",
            controller: "k8s.io/ingress-nginx",
            isDefault: true,
            parameters: null,
          },
        ],
      }),
    listServiceBacking: () => answers.backing(),
    listDeployments: () => Promise.resolve([]),
    listDaemonsets: () => Promise.resolve([]),
  },
}));

const { default: IngressNginxPage } = await import("./page");

const shop: IngressInfo = {
  name: "shop",
  namespace: "web",
  className: "nginx",
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
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  defaultBackend: null,
  labels: {},
  annotations: {},
  createdAt: null,
};

function openOn(tab: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/integrations/ingress-nginx?tab=${tab}`]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(<IngressNginxPage />, { wrapper });
}

beforeEach(() => {
  answers.backing = () =>
    Promise.reject(
      new Error("Tauri command 'listServiceBacking' failed: forbidden", {
        cause: { code: "PERMISSION_DENIED", message: "services is forbidden" },
      })
    );
});

describe("a host with no certificate of its own when the edge could not be read", () => {
  /** With the Services refused, a load balancer in front may hold the certificate, and the row said "no TLS" without looking. Fails if the row reads the edge as none. */
  it("says TLS was not checked on the row, not that there is none", async () => {
    openOn("routes");

    expect(await screen.findByText(/TLS not checked/)).toBeInTheDocument();
    expect(screen.queryByText(/no TLS/)).not.toBeInTheDocument();
  });

  /** The map's tag is the same fact in one word, and said "no TLS" in warn over the same unread edge. */
  it("tags the host as not checked on the map, too", async () => {
    openOn("map");

    expect(await screen.findByText("TLS not checked")).toBeInTheDocument();
    expect(screen.queryByText("no TLS")).not.toBeInTheDocument();
  });

  /** The other half: with the Services read and nothing in front, the host really has no TLS, and says so. */
  it("says no TLS once the edge was read and nothing in front holds one", async () => {
    answers.backing = () => Promise.resolve({ services: [], published: [] });
    openOn("routes");

    expect((await screen.findAllByText(/no TLS/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/TLS not checked/)).not.toBeInTheDocument();
  });
});
