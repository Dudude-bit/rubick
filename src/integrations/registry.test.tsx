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

const { useCapability } = await import("./index");

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
