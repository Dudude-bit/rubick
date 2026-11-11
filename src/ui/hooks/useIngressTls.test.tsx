import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

const asks = vi.hoisted(() => ({ suppliers: null as unknown[] | null }));
vi.mock("@/integrations", () => ({
  useCapabilities: () =>
    asks.suppliers ?? [
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

const SHOP = [{ namespace: "web", name: "shop", hosts: ["shop.example.com"] }];

const unreadWith = async (suppliers: unknown[]) => {
  asks.suppliers = suppliers;
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useIngressTls(SHOP), { wrapper });
  const pending = result.current.unread;
  await waitFor(() => expect(result.current.isPending).toBe(false));
  return { pending, settled: result.current.unread };
};

describe("which controllers have not answered about an Ingress's hosts", () => {
  afterEach(() => {
    asks.suppliers = null;
  });

  const adds = async () => [[]];
  const failing = async () => {
    throw new Error("ingresses is forbidden");
  };

  /**
   * `hostTls` lets spec.tls stand unless the missing answer could replace
   * it. Fails if a silent replacing supplier is reported as one that only
   * adds, which is a Traefik host read as HTTPS on spec.tls alone.
   */
  it("says a supplier whose answer replaces spec.tls is the one still out, and the one that failed", async () => {
    const replacing = Object.assign(failing.bind(null), {
      replacesSpec: true as const,
    });

    expect(await unreadWith([adds, replacing])).toEqual({
      pending: "replaces",
      settled: "replaces",
    });
  });

  /** A cloud supplier's failure leaves spec.tls standing; an answered one leaves nothing out. */
  it("says a supplier that only adds to spec.tls is out, then that nothing is", async () => {
    expect(await unreadWith([failing])).toEqual({
      pending: "adds",
      settled: "adds",
    });
    expect(await unreadWith([adds])).toEqual({
      pending: "adds",
      settled: false,
    });
  });
});

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
