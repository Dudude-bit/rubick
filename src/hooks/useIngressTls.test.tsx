import { describe, expect, it, vi } from "vitest";
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
          by: { key: "awsHttpOnly" },
        }))
      ),
    async (wanted: Array<{ hosts: string[] }>) =>
      wanted.map((entry) =>
        entry.hosts.map((host) => ({
          host,
          terminated: null,
          by: { key: "verbatimLine", values: { said: "shop-cert" } },
        }))
      ),
  ],
}));

import { testQueryClient } from "@/test/render";
import { useIngressTls } from "./useIngressTls";

describe("what the controllers say about an Ingress's host", () => {
  /**
   * Ranked by `Number(terminated)`, a controller that could not tell sorted
   * level with one saying plain HTTP and lost to it by position — so the
   * host read "no TLS" over a certificate nobody could read.
   */
  it("takes one that could not tell over one that said no", async () => {
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useIngressTls([
          { namespace: "web", name: "shop", hosts: ["shop.example.com"] },
        ]),
      { wrapper }
    );
    await waitFor(() => expect(result.current.isPending).toBe(false));

    expect(
      result.current.of({ namespace: "web", name: "shop" }, "shop.example.com")
        ?.terminated
    ).toBeNull();
  });
});
