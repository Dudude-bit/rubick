import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TrafficChain } from "./TrafficChain";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { ServiceEdges } from "@/hooks/useServiceEdge";
import type {
  ChainStop,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

// The hop notes are an extension's, so the chain asks a capability for them.
// Nothing is detected here, which is the state of nearly every cluster and
// the one every assertion below is written against: the chain must read
// exactly the same with no cloud controller installed anywhere.
const detectInClusterExtensions = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => detectInClusterExtensions(),
  },
}));

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );

const service: ObjectRef = {
  kind: "Service",
  name: "demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: {
    kind: "service",
    type: "ClusterIP",
    clusterIp: "10.43.0.9",
    externalName: null,
    selector: "app=demo",
    ports: [],
  },
};

const answered = (stops: ChainStop[]): ResourceConnections => ({
  subject: service,
  edges: [],
  stops,
  published: [],
  notLookedAt: [],
});

const query = (data: ResourceConnections | undefined, isPending = false) =>
  ({ data, error: null, isPending }) as ConnectionsQuery;

describe("TrafficChain", () => {
  it("gives each stop its own answer", () => {
    /** A view that draws all three the same way is a red dot. Each of these
     *  is a different repair — a name to fix, a selector to fix, a probe to
     *  fix — and the sentence is the whole product. */
    const said = (stop: ChainStop) => {
      const view = wrap(<TrafficChain query={query(answered([stop]))} />);
      const text = view.container.textContent ?? "";
      view.unmount();
      return text;
    };

    const missing = said({
      reason: "backendMissing",
      ingress: {
        kind: "Ingress",
        name: "ghost-demo",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: null,
      },
      service,
    });
    const empty = said({
      reason: "selectsNothing",
      service,
      selector: "app=tls-demo",
    });
    const unready = said({
      reason: "noneReady",
      service,
      selector: "app=unready-demo",
      pods: 2,
    });

    expect(missing).toContain("No Service named demo in this namespace");
    expect(empty).toContain("No pod carries app=tls-demo");
    expect(unready).toContain(
      "2 pods carry app=unready-demo, and none of them is ready"
    );
    expect(new Set([missing, empty, unready]).size).toBe(3);
  });

  it("spends one line where there is nothing to draw", () => {
    /** The whole feature has to be free on the pages that do not need it.
     *  A heading over an empty chain is two lines spent saying nothing is
     *  there. */
    wrap(
      <TrafficChain
        query={query({
          subject: {
            kind: "Deployment",
            name: "quiet-demo",
            namespace: "k8s-gui-test",
            existence: "present",
            facts: null,
          },
          edges: [],
          stops: [],
          published: [],
          notLookedAt: [],
        })}
      />
    );

    expect(
      screen.getByText(/No Service in this namespace selects these pods/)
    ).toBeInTheDocument();
    expect(screen.queryByText("How traffic gets here")).not.toBeInTheDocument();
  });

  it("carries the certificate above the Ingress, and reads without one", () => {
    /** The certificate is the first thing a browser consults, so it is the
     *  top of the chain. And it is core: a cluster with nothing installed
     *  on it still gets the expiry, because `tls.crt` states it. The second
     *  half of this test is the promise the extension seam makes — the
     *  chain must be whole before any extension has said anything. */
    const conns: ResourceConnections = {
      subject: {
        kind: "Ingress",
        name: "shop",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: { kind: "ingress", className: "traefik" },
      },
      edges: [
        {
          from: {
            kind: "Ingress",
            name: "shop",
            namespace: "k8s-gui-test",
            existence: "present",
            facts: null,
          },
          to: {
            kind: "Secret",
            name: "shop-tls",
            namespace: "k8s-gui-test",
            existence: "notChecked",
            facts: null,
          },
          relation: {
            verb: "uses",
            usages: [{ how: "ingressTls", hosts: ["shop.k8s-gui.test"] }],
          },
        },
        {
          from: {
            kind: "Ingress",
            name: "shop",
            namespace: "k8s-gui-test",
            existence: "present",
            facts: null,
          },
          to: service,
          relation: {
            verb: "routes",
            host: "shop.k8s-gui.test",
            path: "/",
            pathType: "Prefix",
            port: "80",
            tls: true,
          },
        },
      ],
      stops: [],
      published: [],
      notLookedAt: [],
    };

    const withCert = wrap(
      <TrafficChain
        query={query(conns)}
        certificates={
          new Map([
            [
              "shop-tls",
              {
                secretName: "shop-tls",
                problem: null,
                certificate: {
                  subject: "shop.k8s-gui.test",
                  issuer: "k8s-gui test root",
                  dnsNames: ["shop.k8s-gui.test"],
                  notBefore: "2020-01-01T00:00:00Z",
                  notAfter: "2999-01-01T00:00:00Z",
                  serial: "01",
                  selfSigned: false,
                  chainLength: 1,
                },
              },
            ],
          ])
        }
      />
    );
    expect(withCert.container.textContent).toContain("shop-tls");
    expect(withCert.container.textContent).toMatch(/valid for \d+ days/);
    withCert.unmount();

    const bare = wrap(<TrafficChain query={query(conns)} />);
    expect(bare.container.textContent).toContain("shop-tls");
    expect(bare.container.textContent).toContain("shop.k8s-gui.test/");
    expect(bare.container.textContent).toContain("demo");
  });

  it("says when no controller claims an Ingress", () => {
    /** The failure that looks like nothing at all: correct YAML, no events,
     *  no error, and never served. The classes that do exist are named,
     *  because that turns "it does not work" into a one-word fix. */
    const conns: ResourceConnections = {
      subject: {
        kind: "Ingress",
        name: "ghost-demo",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: { kind: "ingress", className: "nginx" },
      },
      edges: [
        {
          from: {
            kind: "Ingress",
            name: "ghost-demo",
            namespace: "k8s-gui-test",
            existence: "present",
            facts: null,
          },
          to: service,
          relation: {
            verb: "routes",
            host: "ghost-demo.local",
            path: "/",
            pathType: "Prefix",
            port: "80",
            tls: false,
          },
        },
      ],
      stops: [],
      published: [],
      notLookedAt: [],
    };

    wrap(
      <TrafficChain
        query={query(conns)}
        controller={{
          requested: "nginx",
          resolved: null,
          controller: null,
          viaDefault: false,
          available: [
            {
              name: "traefik",
              controller: "traefik.io/ingress-controller",
              isDefault: false,
            },
          ],
        }}
      />
    );

    expect(
      screen.getByText("No IngressClass named nginx in this cluster")
    ).toBeInTheDocument();
    expect(screen.getByText(/This cluster has traefik\./)).toBeInTheDocument();
  });

  it("does not draw a chain it has not read yet", () => {
    /** Loading is its own screen. A blank space where the chain will be
     *  reads as "nothing routes here", which is the one wrong answer. */
    wrap(<TrafficChain query={query(undefined, true)} />);
    expect(screen.getByText("Following the path in…")).toBeInTheDocument();
  });

  describe("what a cloud says about the Service", () => {
    const edges = (edge: Partial<ServiceEdges>): ServiceEdges => ({
      available: true,
      configs: new Map(),
      error: null,
      ...edge,
    });

    // Two hops, because a path of one is not a path and is collapsed to a
    // single line: the Service and the stop below it.
    const chain = answered([
      { reason: "selectsNothing", service, selector: "app=demo" },
    ]);

    const drawWith = (edge: ServiceEdges) => {
      vi.doMock("@/hooks/useServiceEdge", async (original) => ({
        ...(await original<typeof import("@/hooks/useServiceEdge")>()),
        useServiceEdge: () => edge,
      }));
      return import("./TrafficChain");
    };

    it("adds the cloud's configuration under the Service and never instead of it", async () => {
      /** Would break if an extension were ever allowed to replace part of a
       *  hop rather than extend it. The Service's own selector is core and
       *  must still be drawn on a cluster that has every cloud controller
       *  installed — the note is a line below it or nothing at all. */
      vi.resetModules();
      const { TrafficChain: Chain } = await drawWith(
        edges({
          configs: new Map([
            [
              "k8s-gui-test/demo",
              [
                {
                  source: {
                    kind: "BackendConfig",
                    name: "shop-backend",
                    to: "",
                  },
                  summary: "every port · health check HTTP :8080/healthz",
                  problem: null,
                },
              ],
            ],
          ]),
        })
      );
      wrap(<Chain query={query(chain)} />);

      expect(screen.getByText(/selects app=demo/)).toBeInTheDocument();
      expect(screen.getByText("shop-backend")).toBeInTheDocument();
      expect(
        screen.getByText(/health check HTTP :8080\/healthz/)
      ).toBeInTheDocument();
      vi.doUnmock("@/hooks/useServiceEdge");
    });

    it("states configuration plainly and colours only what an object said", async () => {
      /** The line this whole tier turns on. A BackendConfig has no status —
       *  it cannot report a failing health check — so the summary is never
       *  toned. A name that resolves to no object is different in kind: it
       *  was checked, it is missing, and it gets the colour. */
      vi.resetModules();
      const { TrafficChain: Chain } = await drawWith(
        edges({
          configs: new Map([
            [
              "k8s-gui-test/demo",
              [
                {
                  source: { kind: "BackendConfig", name: "ghost", to: "" },
                  summary: "every port",
                  problem: {
                    text: "no BackendConfig named ghost in this namespace — nothing is applied",
                    tone: "err",
                  },
                },
              ],
            ],
          ]),
        })
      );
      const view = wrap(<Chain query={query(chain)} />);

      const problem = screen.getByText(/nothing is applied/);
      expect(problem).toHaveClass("text-err");
      expect(
        view.container.querySelector(".text-err")?.textContent
      ).not.toContain("every port");
      vi.doUnmock("@/hooks/useServiceEdge");
    });

    it("says nothing at all where nothing answered", async () => {
      /** The state every cluster without a cloud controller is in. An
       *  absent capability must leave no gap, no placeholder and no
       *  invitation — the hop is exactly what it was before this existed. */
      vi.resetModules();
      const { TrafficChain: Chain } = await drawWith(
        edges({ available: false })
      );
      const view = wrap(<Chain query={query(chain)} />);

      expect(screen.getByText(/selects app=demo/)).toBeInTheDocument();
      expect(view.container.textContent).not.toContain("BackendConfig");
      vi.doUnmock("@/hooks/useServiceEdge");
    });
  });
});
