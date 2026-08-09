import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { CustomResourceInfo, DetectedExtension } from "@/generated/types";

const detectInClusterExtensions = vi.fn<() => Promise<DetectedExtension[]>>();
const listCustomResources =
  vi.fn<(crdName: string) => Promise<CustomResourceInfo[]>>();
const resolveIngressClass = vi.fn();

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => detectInClusterExtensions(),
    listCustomResources: (crdName: string) => listCustomResources(crdName),
    resolveIngressClass: () => resolveIngressClass(),
    getCertificateIssuance: vi.fn(),
  },
}));

const { IntegrationsSettings } = await import("./IntegrationsSettings");

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

function certificate(
  name: string,
  status: Record<string, unknown>
): CustomResourceInfo {
  return {
    name,
    namespace: "shop",
    uid: name,
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    spec: {},
    status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
  };
}

const READY = { conditions: [{ type: "Ready", status: "True" }] };
const NOT_READY = { conditions: [{ type: "Ready", status: "False" }] };

/** Half a day of slack, so a whole-day count does not round down under it. */
const inDays = (days: number) =>
  new Date(Date.now() + (days + 0.5) * 86_400_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  resolveIngressClass.mockResolvedValue({
    requested: null,
    resolved: null,
    controller: null,
    viaDefault: false,
    available: [],
  });
  listCustomResources.mockResolvedValue([]);
});

describe("the vendors that get a row", () => {
  /**
   * Would break if a vendor that declares what it gives but has no facts
   * implementation stopped rendering. Facts are optional per vendor on
   * purpose — the tree is cheap to add to only for as long as a folder can
   * declare one facet and stop — and Istio is the vendor in exactly that
   * state, so a pane that needed facts to draw a row would silently drop
   * every half-written vendor from the list.
   */
  it("draws a detected vendor that implements no facts", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "istio", installed: true, version: "1.24.0" },
    ]);

    wrap(<IntegrationsSettings />);

    expect(await screen.findByText("detected")).toBeVisible();
    expect(screen.getByText("Istio")).toBeVisible();
    expect(screen.getByText("1.24.0")).toBeVisible();
    expect(
      screen.getByText(/VirtualServices and DestinationRules/)
    ).toBeVisible();
    // And nothing it does not know: no fact line, rather than zeroes.
    expect(screen.queryByRole("link")).toBeNull();
  });

  /**
   * Would break if the cluster's own flavour started appearing as an absent
   * extension. GKE, EKS, AKS, k3s and minikube are vendors in the same tree
   * and are not installable things — "Google Cloud · not installed" is
   * nonsense, because you cannot have a cluster and not have whatever runs
   * it.
   */
  it("leaves the cluster's own flavour out of the list", async () => {
    detectInClusterExtensions.mockResolvedValue([]);

    wrap(<IntegrationsSettings />);

    await screen.findByText(/Nothing installed/);
    for (const vendor of ["Google Cloud", "AWS", "Azure", "k3s", "minikube"]) {
      expect(screen.queryByText(vendor)).toBeNull();
    }
  });
});

describe("the empty state", () => {
  /**
   * Would break if the empty state stopped naming what was looked for or
   * how. "No integrations" leaves the reader unable to tell whether the app
   * checked, checked for the right things, or is broken; the names and the
   * method answer all three, and they are read off the registry so a vendor
   * added tomorrow is named here without anybody remembering to.
   */
  it("names every extension it looked for, and the method", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "cert-manager", installed: false, version: null },
      { id: "traefik", installed: false, version: null },
    ]);

    wrap(<IntegrationsSettings />);

    const looked = await screen.findByText(/Looked for/);
    for (const name of ["cert-manager", "Traefik", "Flux", "Istio"]) {
      expect(looked.textContent).toContain(name);
    }
    expect(looked.textContent).toMatch(/asking the API server for their CRDs/);
  });

  /**
   * Would break if a cluster with nothing installed started costing a list
   * call per vendor. Nothing absent is asked about — the objects it would
   * count cannot exist.
   */
  it("asks the cluster nothing when it has none of them", async () => {
    detectInClusterExtensions.mockResolvedValue([]);

    wrap(<IntegrationsSettings />);

    await screen.findByText(/Nothing installed/);
    expect(listCustomResources).not.toHaveBeenCalled();
  });
});

describe("facts", () => {
  /**
   * Would break if a count stopped being quiet or a problem stopped being
   * coloured. "7 certificates" is inventory and "1 renewal failing" is why
   * the reader came, and the row has exactly one signal to spend.
   */
  it("states inventory quietly and colours the problem", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "cert-manager", installed: true, version: "v1.16.3" },
    ]);
    listCustomResources.mockResolvedValue([
      certificate("shop", { ...READY, notAfter: inDays(80) }),
      certificate("checkout", { ...READY, notAfter: inDays(9) }),
      certificate("billing", { ...NOT_READY, notAfter: inDays(40) }),
      certificate("promo", NOT_READY),
    ]);

    wrap(<IntegrationsSettings />);

    expect(await screen.findByText("4 certificates")).toBeVisible();
    expect(screen.getByText("1 expires in 9 days")).toBeVisible();
    expect(screen.getByText("1 renewal failing")).toBeVisible();
    expect(screen.getByText("1 certificate never issued")).toBeVisible();
  });

  /**
   * Would break if a fact ever stopped ending in a route to the objects it
   * counted. The row is a status list; the moment it answers "which ones"
   * itself it is a second, worse copy of the page that already does.
   */
  it("ends in a route to the objects it counted", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "cert-manager", installed: true, version: null },
    ]);
    listCustomResources.mockResolvedValue([
      certificate("shop", { ...READY, notAfter: inDays(80) }),
      certificate("checkout", { ...READY, notAfter: inDays(80) }),
    ]);

    wrap(<IntegrationsSettings />);

    const link = await screen.findByRole("link", { name: "Show them" });
    expect(link).toHaveAttribute(
      "href",
      "/customresourcedefinitions/certificates.cert-manager.io?tab=instances"
    );
  });

  /**
   * Would break if a detected extension whose objects could not be read
   * fell back to an empty fact list. That row would state, in the app's own
   * quiet voice, that a cluster with two hundred certificates has none —
   * which is a third thing from installed and from absent, and has to read
   * as one.
   */
  it("says a fact load failed rather than showing zero", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "cert-manager", installed: true, version: null },
    ]);
    listCustomResources.mockRejectedValue(new Error("connection refused"));

    wrap(<IntegrationsSettings />);

    expect(
      await screen.findByText(/its objects could not be read/)
    ).toBeVisible();
    expect(screen.queryByText("0 certificates")).toBeNull();
  });

  /**
   * Would break if the pane started reading the cluster while it was merely
   * mounted to be searched. A query mounts every section so its rows can be
   * counted, and mounting is not visiting.
   */
  it("reads nothing while the reader is standing in another section", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "cert-manager", installed: true, version: null },
    ]);

    wrap(<IntegrationsSettings active={false} />);

    expect(await screen.findByText("cert-manager")).toBeVisible();
    expect(listCustomResources).not.toHaveBeenCalled();
  });
});
