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

const { useCapability, useCrdView } = await import("./index");

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
    ["argoproj.io", "Application"],
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
