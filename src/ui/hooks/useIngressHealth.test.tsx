import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/integrations", () => ({
  useCapabilities: () => [
    async (wanted: Array<{ hosts: string[] }>) =>
      wanted.map((entry) =>
        entry.hosts.map((host) => ({
          host,
          terminated: false,
          by: { key: "traefikTlsNotServed" },
          replacesSpec: host.startsWith("promo."),
        }))
      ),
  ],
}));

import type { IngressRule } from "@/generated/types";
import { testQueryClient } from "@/test/render";
import { usePlainHosts } from "./useIngressHealth";

const ingress = (name: string, host: string) => ({
  namespace: "shop",
  name,
  rules: [{ host, paths: [] } as unknown as IngressRule],
});

describe("the hosts an Ingress's controller serves as plain HTTP", () => {
  /**
   * The Ingress status read only `spec.tls`, so a Secret Traefik never
   * presents led the page in red. Fails if a controller that replaces
   * `spec.tls` and says plain is not heard, or if one that only adds to it
   * outvotes `spec.tls`.
   */
  it("holds a host only where the controller's answer replaces spec.tls", async () => {
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const rows = [
      ingress("promo", "promo.example.com"),
      ingress("shop", "shop.example.com"),
    ];
    const { result } = renderHook(() => usePlainHosts(rows), { wrapper });

    await waitFor(() =>
      expect(result.current.has("shop/promo/promo.example.com")).toBe(true)
    );
    expect(result.current.has("shop/shop/shop.example.com")).toBe(false);
  });
});
