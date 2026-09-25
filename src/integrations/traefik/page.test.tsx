import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { IngressInfo } from "@/generated/types";

const answers = vi.hoisted(() => ({
  backing: (): Promise<unknown> => Promise.resolve({}),
  deployments: (): Promise<unknown> => Promise.resolve([]),
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
            name: "traefik",
            controller: "traefik.io/ingress-controller",
            isDefault: true,
            parameters: null,
          },
        ],
      }),
    listServiceBacking: () => answers.backing(),
    listDeployments: () => answers.deployments(),
    getDeployment: () =>
      Promise.resolve({
        containers: [
          {
            name: "traefik",
            image: "traefik:v3",
            command: [],
            args: ["--entrypoints.web.address=:8000"],
          },
        ],
      }),
    listDaemonsets: () => Promise.resolve([]),
  },
}));

const { default: TraefikPage } = await import("./page");

const shop: IngressInfo = {
  name: "shop",
  namespace: "web",
  className: "traefik",
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
      <MemoryRouter initialEntries={[`/integrations/traefik?tab=${tab}`]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  render(<TraefikPage />, { wrapper });
}

beforeEach(() => {
  answers.deployments = () => Promise.resolve([]);
  answers.backing = () =>
    Promise.reject(
      new Error("Tauri command 'listServiceBacking' failed: forbidden", {
        cause: { code: "PERMISSION_DENIED", message: "services is forbidden" },
      })
    );
});

describe("a host with no certificate of its own when the edge could not be read", () => {
  /** With the Services refused, an ALB or GKE Ingress in front may hold the certificate; the finding was withheld and the row beside it still said "no TLS". Fails if the row reads the edge as none. */
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
    // The controller read too: with its entry points unread, one of them may
    // terminate TLS for the host, and "no TLS" would be a guess.
    answers.deployments = () =>
      Promise.resolve([
        {
          name: "traefik",
          namespace: "traefik",
          containers: [{ image: "traefik:v3" }],
          replicas: { ready: 1, desired: 1 },
        },
      ]);
    openOn("routes");

    expect((await screen.findAllByText(/no TLS/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/TLS not checked/)).not.toBeInTheDocument();
  });

  /** And with the entry points unread, "no TLS" is a guess: the row said it
   *  on the left and "TLS not checked" on the right. */
  it("says TLS not checked while the entry points are unread", async () => {
    answers.backing = () => Promise.resolve({ services: [], published: [] });
    openOn("routes");

    expect(await screen.findByText(/TLS not checked/)).toBeInTheDocument();
    expect(screen.queryByText(/no TLS/)).not.toBeInTheDocument();
  });
});
