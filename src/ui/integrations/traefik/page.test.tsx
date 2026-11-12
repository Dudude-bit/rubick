import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";

import type { IngressInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  ingresses: (): Promise<unknown> => Promise.resolve([shop]),
  backing: (): Promise<unknown> => Promise.resolve({}),
  deployments: (): Promise<unknown> => Promise.resolve([]),
  custom: (_crd: string): Promise<unknown> => Promise.resolve([]),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: () => answers.ingresses(),
    listCustomResources: (crd: string) => answers.custom(crd),
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
const { ScreenShareProvider, useScreenSections } =
  await import("@/components/share/screen-share");

const shop: IngressInfo = {
  uid: "",
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

async function openOn(tab: string) {
  let collect: ReturnType<typeof useScreenSections> = null;
  function Probe() {
    collect = useScreenSections();
    return null;
  }
  await renderWithRouter(
    <ScreenShareProvider>
      <TraefikPage />
      <Probe />
    </ScreenShareProvider>,
    {
      at: `/c/prod/integrations/traefik?tab=${tab}`,
      route: "/c/$cluster/integrations/$vendor",
    }
  );
  return () => collect!();
}

beforeEach(() => {
  answers.ingresses = () => Promise.resolve([shop]);
  answers.deployments = () => Promise.resolve([]);
  answers.custom = () => Promise.resolve([]);
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
    await openOn("routes");

    expect((await screen.findAllByText(/no TLS/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/TLS not checked/)).not.toBeInTheDocument();
  });

  /** And with the entry points unread, "no TLS" is a guess: the row said it
   *  on the left and "TLS not checked" on the right. */
  it("says TLS not checked while the entry points are unread", async () => {
    answers.backing = () => Promise.resolve({ services: [], published: [] });
    await openOn("routes");

    expect(await screen.findByText(/TLS not checked/)).toBeInTheDocument();
    expect(screen.queryByText(/no TLS/)).not.toBeInTheDocument();
  });
});

describe("what the Traefik tabs hand to Share", () => {
  /**
   * The map registered nothing: its file was a title over no sections and
   * "everything this report names was read".
   */
  it("gives the map's routers and entry points to the file", async () => {
    const sections = await openOn("map");
    await screen.findByText("TLS not checked");
    await waitFor(() =>
      expect(sections().map((section) => section.id)).toEqual(
        expect.arrayContaining(["traefik-routes-table", "traefik-entry-points"])
      )
    );
  });

  /**
   * "TLS not checked" rests on entry points nobody could read; the Routes
   * file said everything was read and never named them.
   */
  it("names the entry points it could not read beside the routes", async () => {
    answers.backing = () => Promise.resolve({ services: [], published: [] });
    const sections = await openOn("routes");
    await screen.findByText(/TLS not checked/);
    await waitFor(() => {
      const points = sections().find(
        (section) => section.id === "traefik-entry-points"
      );
      expect(points?.unread).toBeTruthy();
    });
  });
});

describe("the Middlewares tab", () => {
  /** It wore "0" while the routes naming them were still being read. Fails if a read on its way is counted. */
  it("wears no number while the routes are still being read", async () => {
    answers.ingresses = () => new Promise(() => {});
    await openOn("routes");

    expect(
      screen.getByRole("tab", { name: /Middlewares/ }).textContent
    ).not.toMatch(/\d/);
  });
});

describe("routes kept under the old API group", () => {
  const legacy = {
    name: "storefront",
    namespace: "web",
    uid: "ir-1",
    apiVersion: "traefik.containo.us/v1alpha1",
    kind: "IngressRoute",
    spec: {
      routes: [{ match: "Host(`old.example.com`)", services: [{ name: "a" }] }],
    },
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
  const proxy = (image: string) => () =>
    Promise.resolve([
      {
        name: "traefik",
        namespace: "traefik",
        containers: [{ image }],
        replicas: { ready: 1, desired: 1 },
      },
    ]);

  beforeEach(() => {
    answers.custom = (crd) =>
      Promise.resolve(
        crd === "ingressroutes.traefik.containo.us" ? [legacy] : []
      );
  });

  /**
   * v3 does not read that group and 2.11 does; with no proxy found to tell
   * which, the route is drawn. Fails if it is drawn as served with nothing
   * on the page saying that was not checked.
   */
  it("says they are drawn without knowing this proxy reads them", async () => {
    await openOn("routes");

    expect(await screen.findByText("old.example.com")).toBeInTheDocument();
    expect(
      screen.getByText(
        /1 IngressRoute here is kept under traefik\.containo\.us/
      )
    ).toBeInTheDocument();
  });

  /** A 2.11 proxy reads both groups, so there is no doubt to print. */
  it("says nothing of the group on a proxy known to read it", async () => {
    answers.deployments = proxy("traefik:v2.11.10");
    await openOn("routes");

    expect(await screen.findByText("old.example.com")).toBeInTheDocument();
    expect(screen.queryByText(/kept under/)).not.toBeInTheDocument();
  });
});
