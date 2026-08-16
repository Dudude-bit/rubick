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

/** A custom resource from one of the clouds' controllers. */
function cloudResource(
  kind: string,
  name: string,
  spec: unknown,
  status: unknown = null
): CustomResourceInfo {
  return {
    name,
    namespace: "shop",
    uid: `${kind}/${name}`,
    apiVersion: "cloud.google.com/v1",
    kind,
    spec,
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

const { useClusterStore } = await import("@/stores/clusterStore");

// The detection scan is gated on a standing connection now — these tests
// exercise what detection hands out, so the gate is opened for them.
beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "test" });
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

describe("the clouds' own controllers", () => {
  /**
   * Would break if a cloud's row ever named the cloud. A cluster cannot fail
   * to be on GKE, so "Google Cloud · not installed" is nonsense — what can be
   * absent is the controllers, and that is what the row is allowed to say it
   * looked for.
   */
  it("names the controller rather than the cloud", async () => {
    detectInClusterExtensions.mockResolvedValue([]);

    wrap(<IntegrationsSettings />);

    expect(await screen.findByText("GKE Ingress")).toBeVisible();
    expect(screen.getByText("AWS Load Balancer Controller")).toBeVisible();
    expect(screen.getByText("AKS add-ons")).toBeVisible();
    expect(screen.queryByText("Google Cloud")).toBeNull();
    expect(screen.queryByText("AWS")).toBeNull();
    expect(screen.queryByText("Azure")).toBeNull();
  });

  /**
   * Would break if the counts that carry no verdict started carrying one, or
   * if a certificate the controller has not written to were sorted into a
   * state. A BackendConfig reports nothing about itself — its upstream type
   * is declared with no status at all — so its count must stay quiet, and
   * only the certificate is allowed the colour.
   */
  it("counts what has no status and colours only what said something", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "gke-ingress", installed: true, version: null },
    ]);
    listCustomResources.mockImplementation(async (crdName: string) => {
      if (crdName === "backendconfigs.cloud.google.com") {
        return [cloudResource("BackendConfig", "shop-backend", {})];
      }
      if (crdName === "managedcertificates.networking.gke.io") {
        return [
          cloudResource(
            "ManagedCertificate",
            "shop",
            {},
            {
              certificateStatus: "FailedNotVisible",
              domainStatus: [
                { domain: "shop.example.com", status: "FailedNotVisible" },
              ],
            }
          ),
          // Never written to by the controller: not failed, not provisioning,
          // and not counted as either.
          cloudResource("ManagedCertificate", "quiet", {}, null),
        ];
      }
      return [];
    });

    wrap(<IntegrationsSettings />);

    expect(
      await screen.findByText(
        "1 BackendConfig · 0 FrontendConfigs · 2 ManagedCertificates"
      )
    ).toBeVisible();
    expect(
      screen.getByText("FailedNotVisible on shop.example.com")
    ).toBeVisible();
    expect(screen.queryByText(/not serving yet/)).toBeNull();
  });

  /**
   * Would break if the AWS row started reporting target health. Whether the
   * targets in a group are passing their checks lives in the ELB API and not
   * in this cluster, and a binding with no conditions is the normal, healthy
   * case — reading that silence as anything is the mistake this whole tier
   * is written to avoid.
   */
  it("says nothing about a binding the controller never complained about", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "aws-load-balancer-controller", installed: true, version: null },
    ]);
    listCustomResources.mockImplementation(async (crdName: string) => {
      if (crdName === "targetgroupbindings.elbv2.k8s.aws") {
        return [
          cloudResource("TargetGroupBinding", "shop-web", {
            serviceRef: { name: "shop-web", port: 80 },
            targetGroupARN:
              "arn:aws:elasticloadbalancing:eu-west-1:1:targetgroup/tg/1",
          }),
        ];
      }
      return [];
    });

    const view = wrap(<IntegrationsSettings />);

    expect(
      await screen.findByText("1 TargetGroupBinding · 0 IngressClassParams")
    ).toBeVisible();
    // The colour is the assertion: the row has exactly one signal to spend,
    // and a binding nothing complained about must not spend it.
    expect(view.container.querySelector(".text-err")).toBeNull();
    expect(view.container.querySelector(".text-warn")).toBeNull();
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
