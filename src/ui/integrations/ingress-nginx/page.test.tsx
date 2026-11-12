import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

import type { IngressInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  backing: (): Promise<unknown> => Promise.resolve({}),
  ingresses: (): Promise<unknown> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: () => answers.ingresses(),
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
  uid: "",
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
  return renderWithRouter(<IngressNginxPage />, {
    at: `/c/prod/integrations/ingress-nginx?tab=${tab}`,
    route: "/c/$cluster/integrations/$vendor",
  });
}

beforeEach(() => {
  answers.ingresses = () => Promise.resolve([shop]);
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
    await openOn("routes");

    expect(await screen.findByText(/TLS not checked/)).toBeInTheDocument();
    expect(screen.queryByText(/no TLS/)).not.toBeInTheDocument();
  });

  /** The map's tag is the same fact in one word, and said "no TLS" in warn over the same unread edge. */
  it("tags the host as not checked on the map, too", async () => {
    await openOn("map");

    expect(await screen.findByText("TLS not checked")).toBeInTheDocument();
    expect(screen.queryByText("no TLS")).not.toBeInTheDocument();
  });

  /** The other half: with the Services read and nothing in front, the host really has no TLS, and says so. */
  it("says no TLS once the edge was read and nothing in front holds one", async () => {
    answers.backing = () => Promise.resolve({ services: [], published: [] });
    await openOn("routes");

    expect((await screen.findAllByText(/no TLS/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/TLS not checked/)).not.toBeInTheDocument();
  });
});

describe("a host whose TLS block names no Secret", () => {
  /**
   * nginx serves it on :443 under its default certificate. The chain drew
   * ":80 / no TLS here" and the row said "no TLS". Fails if the listener or
   * the row reads the missing Secret as no TLS, or names no certificate.
   */
  it("is drawn on :443 under the controller's default certificate", async () => {
    answers.ingresses = () =>
      Promise.resolve([
        {
          ...shop,
          tlsHosts: ["shop.example.com"],
          tlsConfigs: [
            {
              hosts: ["shop.example.com"],
              secretName: null,
              isCatchAll: false,
            },
          ],
        },
      ]);
    // No Service behind it, so the row is broken and opens its chain.
    answers.backing = () => Promise.resolve({ services: [], published: [] });
    await openOn("routes");

    expect(await screen.findByText(":443")).toBeInTheDocument();
    expect(screen.getByText("TLS terminated here")).toBeInTheDocument();
    expect(
      screen.getByText(/default certificate: the tls block names no Secret/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/no TLS/)).not.toBeInTheDocument();
  });
});
