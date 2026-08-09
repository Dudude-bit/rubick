import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { TrafficChain } from "./TrafficChain";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type {
  ChainStop,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

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
});
