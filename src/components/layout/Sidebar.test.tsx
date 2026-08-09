import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { DetectedExtension } from "@/generated/types";

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

vi.mock("@/hooks/useClusterOverview", () => ({
  useClusterOverview: () => ({ data: undefined }),
}));

const { Sidebar } = await import("./Sidebar");

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

beforeEach(() => {
  vi.clearAllMocks();
  listIngresses.mockResolvedValue([]);
  listCustomResources.mockResolvedValue([]);
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
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
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
   * Would break if a detected vendor with no page of its own started
   * appearing here. cert-manager is detected on plenty of clusters and has
   * no page yet; a row leading nowhere is worse than no row.
   */
  it("leaves out a detected vendor that owns no page", async () => {
    detectInClusterExtensions.mockResolvedValue([
      { id: "cert-manager", installed: true, version: "v1.14.0" },
    ]);

    wrap(<Sidebar />);

    expect(await screen.findByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
  });
});
