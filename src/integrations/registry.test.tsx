import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { DetectedExtension } from "@/generated/types";

const detect = vi.fn<() => Promise<DetectedExtension[]>>();

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => detect(),
    getCertificateIssuance: vi.fn(),
  },
}));

const {
  useCapability,
  useCrdView,
  NODE_POOL_LABELS,
  NODE_SPOT_LABELS,
  cloudOfProviderScheme,
  flavourOf,
  flavourOfContext,
} = await import("./index");

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useCapability", () => {
  /**
   * Would break if the app started handing out an implementation for an
   * extension the cluster does not have. Most clusters have none, and a
   * capability that answers anyway is a request that fails at runtime on
   * every one of them.
   */
  it("hands out nothing on a cluster without the extension", async () => {
    detect.mockResolvedValue([
      { id: "cert-manager", installed: false, version: null },
    ]);
    const { result } = renderHook(() => useCapability("certificate.issuance"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(detect).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  /**
   * Would break if detection stopped reaching the surface — the other half
   * of the same promise, and the reason detection is allowed at all: the
   * CRD is there or it is not.
   */
  it("hands out an implementation once the extension is detected", async () => {
    detect.mockResolvedValue([
      { id: "cert-manager", installed: true, version: "v1.16.3" },
    ]);
    const { result } = renderHook(() => useCapability("certificate.issuance"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toBeTypeOf("function"));
  });
});

describe("useCrdView", () => {
  const view = (group: string, kind: string) =>
    renderHook(() => useCrdView(group, kind), { wrapper: wrapper() }).result
      .current;

  /**
   * Would break if a vendor's columns stopped reaching the list page — the
   * whole visible half of the tier-two facet.
   */
  it.each([
    ["cert-manager.io", "Certificate", "Secret"],
    ["traefik.io", "IngressRoute", "Hosts"],
    ["traefik.containo.us", "IngressRoute", "Hosts"],
    ["helm.toolkit.fluxcd.io", "HelmRelease", "Chart"],
    ["argoproj.io", "Application", "Sync"],
    ["networking.istio.io", "VirtualService", "Gateways"],
  ])("draws %s/%s with the vendor's own columns", (group, kind, header) => {
    const columns = view(group, kind)?.columnsFor(kind);
    expect(columns?.map((c) => c.header)).toContain(header);
  });

  /**
   * Would break if a vendor started claiming a group it does not own. A CRD
   * nobody here has heard of must keep the printer columns its own author
   * wrote, which is the fallback the absent view selects.
   */
  it.each([
    // `argoproj.io` is not Argo CD's alone: Argo Rollouts and Argo Workflows
    // put their kinds in the same group, and drawing a Workflow with a sync
    // status it does not have is what claiming the group would cause.
    ["argoproj.io", "Workflow"],
    ["argoproj.io", "Rollout"],
    ["source.toolkit.fluxcd.io", "GitRepository"],
    ["", "Widget"],
  ])("claims nothing for %s/%s", (group, kind) => {
    expect(view(group, kind)).toBeNull();
  });

  /**
   * Would break if a kind the vendor has not been taught fell through to no
   * columns at all — an empty list page instead of a slightly generic one.
   */
  it("falls back to the vendor's default columns for a kind it does not know", () => {
    const columns = view("cert-manager.io", "Challenge")?.columnsFor(
      "Challenge"
    );
    expect(columns?.length).toBeGreaterThan(0);
  });

  /**
   * The point of the consolidation, held in place: cert-manager's capability
   * and its columns are two facets of one vendor, not two systems that each
   * had to be told about it.
   */
  it("reads both of cert-manager's facets off one entry", () => {
    expect(view("cert-manager.io", "Certificate")).not.toBeNull();
    detect.mockResolvedValue([
      { id: "cert-manager", installed: true, version: null },
    ]);
    const { result } = renderHook(() => useCapability("certificate.issuance"), {
      wrapper: wrapper(),
    });
    return waitFor(() => expect(result.current).toBeTypeOf("function"));
  });
});

describe("node label tables", () => {
  /**
   * Would break if a vendor's spelling were lost or reordered by the move
   * out of `lib/node-pool.ts`. The list is asserted whole rather than by
   * membership: order is the tie-break when two vendors could claim a node,
   * and a silent reordering is exactly the kind of change that shows up as
   * a wrong pool name on somebody's cluster and nowhere in a test.
   *
   * The one pair whose order the move did change is EKS and GKE, and it
   * cannot matter: a node is in one cloud, so no node carries both labels.
   * The pair that does matter is Karpenter before AKS — an AKS node made by
   * node auto-provisioning carries both, and the pool Karpenter named is
   * the one that explains the node.
   */
  it("spells the pool label the way each vendor writes it, in registry order", () => {
    expect([...NODE_POOL_LABELS]).toEqual([
      "eks.amazonaws.com/nodegroup",
      "cloud.google.com/gke-nodepool",
      "karpenter.sh/nodepool",
      "karpenter.sh/provisioner-name",
      "kubernetes.azure.com/agentpool",
    ]);
  });

  it("keeps every spelling of spot the four vendors use", () => {
    expect(
      [...NODE_SPOT_LABELS].map(([key, value]) => `${key}=${value}`).sort()
    ).toEqual([
      "cloud.google.com/gke-preemptible=true",
      "cloud.google.com/gke-provisioning=preemptible",
      "cloud.google.com/gke-provisioning=spot",
      "cloud.google.com/gke-spot=true",
      "eks.amazonaws.com/capacityType=spot",
      "karpenter.sh/capacity-type=spot",
      "kubernetes.azure.com/priority=spot",
      "kubernetes.azure.com/scalesetpriority=spot",
    ]);
  });

  /**
   * Would break if an unrecognised scheme started being guessed at. k3s
   * writes `k3s://<node-name>` on every node in the world, so a wrong
   * answer here would name a cloud on every k3d cluster.
   */
  it.each([
    ["gce", "Google Cloud"],
    ["aws", "AWS"],
    ["azure", "Azure"],
  ])("names the cloud behind providerID scheme %s", (scheme, cloud) => {
    expect(cloudOfProviderScheme(scheme)).toBe(cloud);
  });

  it.each(["k3s", "openstack", "hcloud", ""])(
    "names no cloud for scheme %s",
    (scheme) => {
      expect(cloudOfProviderScheme(scheme)).toBeNull();
    }
  );
});

describe("cluster flavours", () => {
  /**
   * Would break if the vendors were reordered in the registry. A context
   * name can carry more than one vendor's marker, and the first vendor to
   * claim it wins — so a k3d cluster named after the cloud it stands in for
   * has to keep reading as local, and an EKS ARN must not be read as
   * something looser that happens to appear later in the same string.
   */
  it("is tested most specific vendor first", () => {
    expect(flavourOfContext("k3d-prod-eks-replica")?.id).toBe("k3d");
    expect(
      flavourOfContext("arn:aws:eks:eu-west-1:1:cluster/gke-lift")?.id
    ).toBe("eks");
  });

  /**
   * Would break if a vendor stopped carrying its own mark. `null` is the
   * generic answer and draws the Kubernetes heptagon, which is also what
   * k3d and k3s get by declaring no mark of their own.
   */
  it.each([
    ["eks", true],
    ["gke", true],
    ["aks", true],
    ["minikube", true],
    ["k3d", false],
    ["k3s", false],
  ] as const)("gives %s a mark: %s", (provider, hasMark) => {
    expect(flavourOf(provider)?.mark != null).toBe(hasMark);
  });

  it("knows no flavour called generic", () => {
    expect(flavourOf("generic")).toBeNull();
  });
});
