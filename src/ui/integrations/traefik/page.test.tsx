import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";

import type { IngressInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";

const answers = vi.hoisted(() => ({
  ingresses: (): Promise<unknown> => Promise.resolve([shop]),
  backing: (): Promise<unknown> => Promise.resolve({}),
  deployments: (): Promise<unknown> => Promise.resolve([]),
  custom: (_crd: string): Promise<unknown> => Promise.resolve([]),
  args: ["--entrypoints.web.address=:8000"],
  httpRoutes: vi.fn((): Promise<unknown> => Promise.resolve([])),
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
            args: answers.args,
          },
        ],
      }),
    listGatewayRoutes: () => answers.httpRoutes(),
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
  answers.args = ["--entrypoints.web.address=:8000"];
  answers.httpRoutes.mockReset().mockResolvedValue([]);
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
  const orphan = {
    name: "orphan",
    namespace: "web",
    uid: "mw-1",
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    spec: { compress: {} },
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
  const withOrphan = (crd: string) =>
    Promise.resolve(crd === "middlewares.traefik.io" ? [orphan] : []);

  /**
   * An entry point's flag can put a middleware on every router. With the
   * proxy not found its flags are unread: the row said "does nothing" and
   * the tab wore "1 middleware unused". Fails if either is said unread.
   */
  it("does not call a middleware unused while the proxy's flags are unread", async () => {
    answers.custom = withOrphan;
    const sections = await openOn("middlewares");

    expect(
      await screen.findByText(
        /whether an entry point or an HTTPRoute does was not read/
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/does nothing/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Middlewares/ })
    ).not.toHaveAccessibleName(/unused/);
    // The shared file lists no finding and says what it did not read.
    const shared = sections().find(
      (section) => section.id === "traefik-middlewares"
    );
    expect(shared?.count).toBe(0);
    expect(shared?.unread).toMatch(/was not read/);
  });

  const proxyFound = () =>
    Promise.resolve([
      {
        name: "traefik",
        namespace: "traefik",
        containers: [{ image: "traefik:v3" }],
        replicas: { ready: 1, desired: 1 },
      },
    ]);
  const failed = (code: string, message: string) =>
    new Error(`Tauri command 'listGatewayRoutes' failed: ${message}`, {
      cause: { code, message },
    });

  /**
   * The other half: flags read, no Gateway API provider among them, nothing
   * naming it. Fails if it is not called unused, or if HTTPRoutes are listed
   * for a proxy that never reads them.
   */
  it("calls it unused once the flags were read and nothing names it", async () => {
    answers.custom = withOrphan;
    answers.deployments = proxyFound;
    await openOn("middlewares");

    expect(
      await screen.findByText(/so it is configuration that does nothing/)
    ).toBeInTheDocument();
    expect(answers.httpRoutes).not.toHaveBeenCalled();
  });

  /**
   * With the Gateway API provider on, an HTTPRoute's filter can name it.
   * Fails if a refused HTTPRoute list is read as "no HTTPRoute names it".
   */
  it("does not call it unused where HTTPRoutes could not be listed", async () => {
    answers.custom = withOrphan;
    answers.deployments = proxyFound;
    answers.args = ["--providers.kubernetesgateway"];
    answers.httpRoutes.mockRejectedValue(
      failed("PERMISSION_DENIED", "httproutes is forbidden")
    );
    await openOn("middlewares");

    await waitFor(() => expect(answers.httpRoutes).toHaveBeenCalled());
    // The row reads "not read" while the list is on its way too, so the
    // wrong answer is waited for rather than looked for once.
    await expect(
      screen.findByText(/does nothing/, {}, { timeout: 300 })
    ).rejects.toThrow();
    expect(
      screen.getByText(
        /whether an entry point or an HTTPRoute does was not read/
      )
    ).toBeInTheDocument();
  });

  /** A cluster that does not serve the kind has no HTTPRoute to name anything. Fails if that is left "not read" for good. */
  it("takes a cluster without Gateway API as having no HTTPRoute", async () => {
    answers.custom = withOrphan;
    answers.deployments = proxyFound;
    answers.args = ["--providers.kubernetesgateway"];
    answers.httpRoutes.mockRejectedValue(failed("NOT_FOUND", "not found"));
    await openOn("middlewares");

    expect(
      await screen.findByText(/so it is configuration that does nothing/)
    ).toBeInTheDocument();
  });

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

describe("a route balanced across several Services", () => {
  /** Two rows of one path read as two routers. Fails if the split is not said on each. */
  it("names each Service's weight beside it", async () => {
    answers.custom = (crd) =>
      Promise.resolve(
        crd === "ingressroutes.traefik.io"
          ? [
              {
                name: "canary",
                namespace: "web",
                uid: "ir-2",
                apiVersion: "traefik.io/v1alpha1",
                kind: "IngressRoute",
                spec: {
                  routes: [
                    {
                      match: "Host(`app.example.com`)",
                      services: [
                        { name: "app-v1", weight: 3 },
                        { name: "app-v2", weight: 1 },
                      ],
                    },
                  ],
                },
                status: null,
                labels: {},
                annotations: {},
                createdAt: null,
                ownerReferences: [],
                generation: null,
              },
            ]
          : []
      );
    // Neither Service exists, so the row is broken and opens by itself.
    answers.backing = () => Promise.resolve({ services: [], published: [] });
    await openOn("routes");

    expect(await screen.findByText("weight 3")).toBeInTheDocument();
    expect(screen.getByText("weight 1")).toBeInTheDocument();
  });
});
