import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { getTlsCertificates: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { certificateProblems, useRouteCertificates } from "./ingress";

const read = vi.mocked(commands.getTlsCertificates);
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const routes = [
  { source: { namespace: "shop" }, tlsSecret: "shop-tls" },
  { source: { namespace: "shop" }, tlsSecret: "shop-tls" },
  { source: { namespace: "blog" }, tlsSecret: "blog-tls" },
  { source: { namespace: "blog" }, tlsSecret: null },
];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  read.mockReset();
  read.mockImplementation(async (namespace, names) =>
    names.map((secretName) => ({ secretName, namespace }) as never)
  );
});

describe("the certificates a page's routes are served under", () => {
  /**
   * The pages memoised on `certificates.size`, because a new Map came back
   * every render: a renewed certificate kept its count and never reached
   * the screen. The Map is now the same object until a read changes.
   */
  it("is the same map across renders until a read changes", async () => {
    const { result, rerender } = renderHook(
      ({ list }) => useRouteCertificates(list),
      { wrapper, initialProps: { list: routes } }
    );
    await waitFor(() => expect(result.current.size).toBe(2));
    const first = result.current;
    rerender({ list: routes });
    expect(result.current).toBe(first);
    expect([...first.keys()].sort()).toEqual([
      "blog/blog-tls",
      "shop/shop-tls",
    ]);
  });

  /** One read per namespace, on the key the Ingress page reads too. */
  it("reads each namespace once, under the core key", async () => {
    const { result } = renderHook(() => useRouteCertificates(routes), {
      wrapper,
    });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      client.getQueryData(["tls-certificates", "shop", "shop-tls"])
    ).toBeInstanceOf(Map);
  });

  /**
   * A read that failed whole left its Secrets out of the map, and
   * `certificateProblems` skips a Secret it has no entry for — a host whose
   * certificate nobody read showed no trouble at all. Fails if a failed
   * batch is dropped again.
   */
  it("carries every Secret of a failed read as unread, not as fine", async () => {
    read.mockRejectedValue(new Error("Not connected to prod"));
    const { result } = renderHook(() => useRouteCertificates(routes), {
      wrapper,
    });
    await waitFor(() => expect(result.current.size).toBe(2));

    const problems = certificateProblems(
      [{ namespace: "shop", secretName: "shop-tls" }],
      result.current
    );
    expect(problems).toEqual([
      expect.objectContaining({
        severity: "warn",
        read: expect.objectContaining({
          problem: { says: "secretUnreadable", said: "Not connected to prod" },
        }),
      }),
    ]);
  });
});
