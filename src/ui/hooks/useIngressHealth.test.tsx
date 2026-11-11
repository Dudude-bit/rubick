import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

const traefik = vi.hoisted(() => {
  const ask = vi.fn(async (wanted: Array<{ hosts: string[] }>) =>
    wanted.map((entry) =>
      entry.hosts.map((host) => ({
        host,
        terminated: false,
        by: { key: "traefikTlsNotServed" },
        replacesSpec: host.startsWith("promo."),
      }))
    )
  );
  return { ask, suppliers: [Object.assign(ask, { replacesSpec: true })] };
});
vi.mock("@/integrations", () => ({
  useCapabilities: () => traefik.suppliers,
}));

import type { IngressRule } from "@/generated/types";
import { testQueryClient } from "@/test/render";
import { usePlainHosts } from "./useIngressHealth";

const ingress = (name: string, host: string) => ({
  namespace: "shop",
  name,
  rules: [{ host, paths: [] } as unknown as IngressRule],
});

const rows = [
  ingress("promo", "promo.example.com"),
  ingress("shop", "shop.example.com"),
];

const plainHosts = (asks: boolean) => {
  const client = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePlainHosts(rows, asks), { wrapper }).result;
};

describe("the hosts an Ingress's controller serves as plain HTTP", () => {
  afterEach(() => {
    traefik.ask.mockClear();
    traefik.suppliers = [Object.assign(traefik.ask, { replacesSpec: true })];
  });

  /**
   * The Ingress status read only `spec.tls`, so a Secret Traefik never
   * presents led the page in red. Fails if a controller that replaces
   * `spec.tls` and says plain is not heard, or if one that only adds to it
   * outvotes `spec.tls`.
   */
  it("holds a host only where the controller's answer replaces spec.tls", async () => {
    const result = plainHosts(true);

    await waitFor(() =>
      expect(result.current(rows[0], "promo.example.com")).toBe(true)
    );
    expect(result.current(rows[1], "shop.example.com")).toBe(false);
  });

  /** Until that controller answers, "not plain" would be spec.tls speaking for it. */
  it("does not know a host while the controller that replaces spec.tls is still out", async () => {
    const result = plainHosts(true);

    expect(result.current(rows[0], "promo.example.com")).toBeNull();
    await waitFor(() =>
      expect(result.current(rows[0], "promo.example.com")).toBe(true)
    );
  });

  /**
   * The shell's count asked every supplier about every Ingress in the
   * cluster. Fails if a caller that does not ask still reaches a supplier,
   * or is told "not plain" on a cluster where one could have said plain.
   */
  it("asks no controller when told not to, and does not know where one could have said plain", async () => {
    const result = plainHosts(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(traefik.ask).not.toHaveBeenCalled();
    expect(result.current(rows[0], "promo.example.com")).toBeNull();
    expect(result.current(rows[1], "shop.example.com")).toBeNull();
  });

  /**
   * The Ingress list had asked, and the count on every screen still said
   * "not checked" beside it. Fails if a caller that does not ask stops
   * reading an answer the cache already holds, or asks for one itself.
   */
  it("reads, unasked, what a caller that asks was already told", async () => {
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const shell = renderHook(() => usePlainHosts(rows, false), { wrapper });
    expect(shell.result.current(rows[0], "promo.example.com")).toBeNull();

    const list = renderHook(() => usePlainHosts(rows, true), { wrapper });
    await waitFor(() =>
      expect(shell.result.current(rows[0], "promo.example.com")).toBe(true)
    );
    expect(shell.result.current(rows[1], "shop.example.com")).toBe(false);
    expect(traefik.ask).toHaveBeenCalledTimes(1);

    list.unmount();
    shell.rerender();
    expect(traefik.ask).toHaveBeenCalledTimes(1);
  });

  /** A cloud's supplier only adds to spec.tls, so unasked it leaves the field standing. */
  it("knows no host is plain, unasked, where no controller here replaces spec.tls", async () => {
    const cloud = vi.fn(async () => []);
    traefik.suppliers = [cloud as never];
    const result = plainHosts(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cloud).not.toHaveBeenCalled();
    expect(result.current(rows[0], "promo.example.com")).toBe(false);
  });
});
