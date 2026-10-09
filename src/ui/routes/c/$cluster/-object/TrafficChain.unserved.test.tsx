import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ConnectionsQuery } from "@/hooks/useConnections";
import type {
  IngressClassBinding,
  IngressInfo,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";
import { renderWithRouter } from "@/test/render";
import { TrafficChain } from "./TrafficChain";

/** shop as `get_ingress` returns it on a cluster with no IngressClass at all. */
const shop: IngressInfo = {
  name: "shop",
  namespace: "k8s-gui-test",
  className: "nginx",
  rules: [
    {
      host: "shop.k8s-gui.test",
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: "log-demo",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  defaultBackend: null,
  loadBalancerIps: [],
  tlsHosts: [],
  tlsConfigs: [],
  hasCatchAllTls: false,
  labels: {},
  annotations: {},
  createdAt: "2026-10-06T22:00:00Z",
};

const unserved: IngressClassBinding = {
  requested: "nginx",
  resolved: null,
  controller: null,
  viaDefault: false,
  available: [],
};

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => Promise.resolve([]),
    getIngress: () => Promise.resolve(shop),
    resolveIngressClass: () => Promise.resolve(unserved),
  },
}));

const pod: ObjectRef = {
  kind: "Pod",
  name: "log-demo-84c4d9749c-pws9g",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: null,
};

const service: ObjectRef = {
  kind: "Service",
  name: "log-demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: {
    kind: "service",
    type: "ClusterIP",
    clusterIp: "10.96.108.139",
    externalName: null,
    selector: "app=log-demo",
    ports: [],
  },
};

const ingress: ObjectRef = {
  kind: "Ingress",
  name: "shop",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: { kind: "ingress", className: "nginx" },
};

const around = (subject: ObjectRef): ResourceConnections => ({
  subject,
  edges: [
    {
      from: service,
      to: pod,
      relation: { verb: "selects", selector: "app=log-demo" },
    },
    {
      from: ingress,
      to: service,
      relation: {
        verb: "routes",
        host: "shop.k8s-gui.test",
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
});

const query = (data: ResourceConnections) =>
  ({ data, error: null, isPending: false }) as ConnectionsQuery;

describe("an Ingress no controller serves, seen from what it routes to", () => {
  /**
   * The Service and Pod pages said "No address yet: the controller has
   * published none" right under "No IngressClass named nginx ... never will".
   * Fails if the Ingress hop reads an unserved class as a pending address.
   */
  it.each([
    ["Service", service],
    ["Pod", pod],
  ])(
    "says no controller on the %s page, and never that one is on its way",
    async (_kind, subject) => {
      await renderWithRouter(<TrafficChain query={query(around(subject))} />);
      expect(
        await screen.findByText("No IngressClass named nginx in this cluster")
      ).toBeInTheDocument();
      expect(screen.queryByText(/No address yet/)).toBeNull();
    }
  );
});

describe("many Ingresses asking for one class nothing serves", () => {
  const canary: ObjectRef = { ...ingress, name: "shop-canary" };
  const both = around(pod);
  both.edges.push({ ...both.edges[1], from: canary });

  /**
   * Sam's log-demo pod repeated the whole "Nothing has picked this Ingress
   * up" paragraph under each of its 13 Ingresses. Fails if the repair is said
   * more than once, or the count and the class stop being named.
   */
  it("says the repair once, naming how many ask and for which class", async () => {
    await renderWithRouter(<TrafficChain query={query(both)} />);
    expect(
      await screen.findByText(
        "2 Ingresses here ask for an IngressClass this cluster does not have: nginx"
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Nothing has picked/)).toHaveLength(1);
    expect(screen.queryByText(/Nothing has picked this Ingress up/)).toBeNull();
  });

  /**
   * The same pod still printed "No IngressClass named nginx in this cluster"
   * above each of its 13 Ingresses under the summary that already said it.
   * Fails if a row says the sentence again, or stops marking which class it
   * lacks.
   */
  it("marks each Ingress with the class it lacks, not the summary's sentence again", async () => {
    await renderWithRouter(<TrafficChain query={query(both)} />);
    const markers = await screen.findAllByRole("img", {
      name: "No IngressClass named nginx in this cluster",
    });
    expect(markers).toHaveLength(2);
    for (const marker of markers) expect(marker.textContent).toBe("nginx");
    expect(
      screen.queryByText("No IngressClass named nginx in this cluster")
    ).toBeNull();
  });
});
