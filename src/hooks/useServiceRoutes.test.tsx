import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations", () => ({
  useCapabilities: () => [
    () => Promise.reject(new Error("ingressroutes.traefik.io is forbidden")),
  ],
}));

import { testQueryClient } from "@/test/render";
import { useServicesRoutes } from "./useServiceRoutes";

describe("the routes vendors state for several Services", () => {
  /**
   * The one-Service hook carried a supplier's failure; the several-Service
   * one dropped it, so a refused vendor read looked exactly like "no vendor
   * routes this" in the traffic chain and the peek.
   */
  it("carries a supplier that did not answer", async () => {
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useServicesRoutes([{ namespace: "shop", name: "web" }]),
      { wrapper }
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toContain("forbidden");
    expect(result.current.routes.size).toBe(0);
  });
});
