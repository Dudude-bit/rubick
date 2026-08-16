import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ClusterOverview, DetectedExtension } from "@/generated/types";

const detectInClusterExtensions = vi.fn<() => Promise<DetectedExtension[]>>();
const listIngresses = vi.fn().mockResolvedValue([]);
const listCustomResources = vi.fn().mockResolvedValue([]);
const resolveIngressClass = vi.fn().mockResolvedValue({
  requested: null,
  resolved: null,
  controller: null,
  viaDefault: false,
  available: [],
});

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => detectInClusterExtensions(),
    listIngresses: () => listIngresses(),
    listCustomResources: (crdName: string) => listCustomResources(crdName),
    resolveIngressClass: () => resolveIngressClass(),
    getClusterOverview: vi.fn().mockResolvedValue(null),
  },
}));

/** Only the three fields the rail reads; the rest of the overview is noise here. */
type OverviewStub = Pick<
  ClusterOverview,
  "counts" | "problems" | "problemsTruncated"
>;
let overview: OverviewStub | undefined;
vi.mock("@/hooks/useClusterOverview", () => ({
  // Deliberately ignores `enabled`, the way React Query's own
  // `keepPreviousData` does: the hook goes on handing back the last cluster's
  // answer after a disconnect, which is the condition the rail must survive.
  useClusterOverview: () => ({ data: overview }),
  useScopedOverview: () => ({ data: overview }),
}));

const { Sidebar } = await import("./Sidebar");
const { useClusterStore } = await import("@/stores/clusterStore");
const { useUpdaterStore } = await import("@/stores/updaterStore");

function wrap(node: ReactNode, route: string[] = ["/"]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={route}>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listIngresses.mockResolvedValue([]);
  listCustomResources.mockResolvedValue([]);
  detectInClusterExtensions.mockResolvedValue([]);
  overview = undefined;
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
  useUpdaterStore.setState({ available: false });
});

/** An overview carrying one recognisable number and nothing else. */
function overviewWithPods(pods: number): OverviewStub {
  return {
    counts: { pods } as ClusterOverview["counts"],
    problems: [],
    problemsTruncated: 0,
  };
}

describe("the counts at the end of each row", () => {
  it("prints the cluster's numbers while there is a cluster", async () => {
    overview = overviewWithPods(41);
    wrap(<Sidebar />);
    expect(await screen.findByText("41")).toBeInTheDocument();
  });

  /**
   * Would break if the rail went on printing the counts of the cluster the
   * reader just left. The overview query keeps its last answer as
   * placeholder data across the key change a disconnect causes, so
   * "is there data" is not the question — "is there a cluster" is. The
   * status bar has always answered it this way.
   */
  it("prints none of them once there is no cluster", async () => {
    overview = overviewWithPods(41);
    useClusterStore.setState({ isConnected: false, currentContext: null });

    wrap(<Sidebar />);

    expect(await screen.findByText("Pods")).toBeInTheDocument();
    expect(screen.queryByText("41")).not.toBeInTheDocument();
  });
});

describe("the update dot", () => {
  /**
   * Would break if the dot went back to `/settings`, which redirects to
   * Appearance — the one pane that says nothing about updates. The dot is a
   * deep link; it has to land where the update is.
   */
  it("sends the Settings row to About while an update is waiting", async () => {
    useUpdaterStore.setState({ available: true });
    wrap(<Sidebar />);

    expect(
      await screen.findByRole("link", { name: "Settings" })
    ).toHaveAttribute("href", "/settings/about");
  });

  it("leaves the row alone when no update is waiting", async () => {
    wrap(<Sidebar />);
    expect(
      await screen.findByRole("link", { name: "Settings" })
    ).toHaveAttribute("href", "/settings");
  });

  /**
   * The row points at one pane and owns five. Would break if the four panes
   * it no longer names stopped marking it, leaving Settings open with no
   * row in the rail lit.
   */
  it("still marks the row from a pane it does not point at", async () => {
    useUpdaterStore.setState({ available: true });
    wrap(<Sidebar />, ["/settings/registries"]);

    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link.className).toContain("bg-sel");
  });
});

describe("the Network group", () => {
  /**
   * Endpoints was collateral of a nav rebuild and spent months reachable
   * only by typing the URL. Services name the endpoints behind one Service;
   * this list is the only answer to "what is behind everything at once".
   */
  it("offers Endpoints its own row", async () => {
    wrap(<Sidebar />);
    expect(
      await screen.findByRole("link", { name: "Endpoints" })
    ).toHaveAttribute("href", "/network/endpoints");
  });
});

describe("the Integrations category", () => {
  /**
   * The rule this group exists to keep. Would break if the category ever
   * drew itself over an empty list — a caption above a gap on the majority
   * of clusters, which is exactly the "empty rather than absent" the design
   * refuses. Hiding it is only safe because Settings → Integrations still
   * names every extension the app knows, so this must stay a claim about
   * what the cluster *has*.
   */
  it("is absent, not empty, when nothing is detected", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "traefik", installed: false, version: null },
      { id: "cert-manager", installed: false, version: null },
    ]);

    wrap(<Sidebar />);

    // Settings is the last row on every screen, and proves the rail rendered.
    expect(await screen.findByText("Settings")).toBeInTheDocument();
    // While the scan runs the group holds its place with a skeleton; the
    // claim under test is about what it does once the answer is in: an
    // empty result removes the group, caption and all.
    await waitFor(() =>
      expect(screen.queryByText("Integrations")).not.toBeInTheDocument()
    );
    expect(screen.queryByRole("link", { name: /Traefik/ })).toBeNull();
  });

  /**
   * Would break if a detected vendor that owns a page stopped reaching the
   * rail — the only way into the page other than a typed URL.
   */
  it("names a detected vendor that owns a page, and links to it", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "traefik", installed: true, version: "v2.11.18" },
    ]);

    wrap(<Sidebar />);

    const link = await screen.findByRole("link", { name: /Traefik/ });
    expect(link).toHaveAttribute("href", "/integrations/traefik");
    expect(screen.getByText("Integrations")).toBeInTheDocument();
  });

  /**
   * Would break if a detected vendor were dropped from the rail again. The
   * category used to list only vendors declaring a page, so a cluster running
   * one that did not was told it had no integrations at all.
   *
   * It is asserted through a vendor that *has* a page because there is no
   * longer a detected one without: every tier-2 record now owns a screen. The
   * Settings fallback stays live for a *configured* vendor — Prometheus and
   * Loki reach the rail by answering a probe rather than by a CRD scan, and
   * neither declares a page — and that path is not reachable from here,
   * because this file mocks the CRD scan and not the probe.
   */
  it("lists a detected vendor whether or not it is the one being looked for", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "cert-manager", installed: true, version: "v1.16.2" },
      { id: "aws-load-balancer-controller", installed: true, version: null },
    ]);

    wrap(<Sidebar />);

    expect(
      await screen.findByRole("link", { name: /cert-manager/i })
    ).toHaveAttribute("href", "/integrations/cert-manager");
    expect(
      screen.getByRole("link", { name: /AWS Load Balancer Controller/i })
    ).toHaveAttribute("href", "/integrations/aws-load-balancer-controller");
  });

  /**
   * Would break if a vendor the cluster does not have started appearing.
   * The category is a claim about what this cluster *has*, not about what
   * the app knows how to read.
   */
  it("leaves out an extension this cluster does not have", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "traefik", installed: true, version: "v2.11.18" },
      { id: "cert-manager", installed: false, version: null },
    ]);

    wrap(<Sidebar />);

    await screen.findByRole("link", { name: /Traefik/ });
    expect(screen.queryByRole("link", { name: /cert-manager/ })).toBeNull();
  });
});
