import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Scoped, ServiceHealthInputs } from "@/generated/types";

const listServiceHealthInputs =
  vi.fn<(scope: string[] | null) => Promise<Scoped<ServiceHealthInputs>>>();

vi.mock("@/lib/commands", () => ({
  commands: {
    listServiceHealthInputs: (scope: string[] | null) =>
      listServiceHealthInputs(scope),
  },
}));

const { useServiceHealthInputs } = await import("./useServiceHealthInputs");

function wrapper(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const SERVING = {
  type: "ClusterIP",
  selectorless: false,
  ready: 2,
  draining: 0,
  notReady: 0,
  unrouted: 0,
};

describe("the Services of a scope as their verdict reads them", () => {
  /**
   * One read for three namespaces, one refused. The refused one must read as
   * not checked, the one with no Services as none, and every Service named in
   * a group must be found by its own name. Fails if a refused namespace is
   * answered with an empty map, or a group is found only by its first name.
   */
  it("keeps a refused namespace apart from one that has no Services", async () => {
    listServiceHealthInputs.mockResolvedValue({
      rows: [
        { namespace: "net", groups: [{ ...SERVING, names: ["api", "web"] }] },
      ],
      unread: [
        {
          namespace: "secret-ns",
          code: "PERMISSION_DENIED",
          message: "services is forbidden",
        },
      ],
    });

    const { result } = renderHook(
      () => useServiceHealthInputs(["net", "secret-ns", "empty"]),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.in("net").known).toBe(true));
    const net = result.current.in("net");
    expect(net.known && net.value.get("web")?.ready).toBe(2);
    expect(net.known && net.value.get("api")?.ready).toBe(2);
    expect(result.current.in("secret-ns")).toEqual({
      known: false,
      why: "services is forbidden",
    });
    const empty = result.current.in("empty");
    expect(empty.known && empty.value.size).toBe(0);
    expect(result.current.unread).toEqual([
      {
        namespace: "secret-ns",
        code: "PERMISSION_DENIED",
        message: "services is forbidden",
      },
    ]);
    expect(listServiceHealthInputs).toHaveBeenCalledWith([
      "net",
      "secret-ns",
      "empty",
    ]);
  });

  /**
   * A namespace the scope never asked about was not looked at. Fails if it
   * reads as a namespace with no Services, which would call every backend
   * there missing.
   */
  it("does not answer for a namespace outside the scope", async () => {
    listServiceHealthInputs.mockResolvedValue({ rows: [], unread: [] });

    const { result } = renderHook(() => useServiceHealthInputs(["net"]), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.in("net").known).toBe(true));
    expect(result.current.in("shop")).toEqual({ known: false, why: null });
  });

  /**
   * The answer before a failure is still held, and the count built on it
   * must not read as current. Fails if a failed re-read hides behind the
   * last good answer, which kept a lost cluster's count "all checked".
   */
  it("names a failed re-read while the last answer is still held", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    listServiceHealthInputs.mockResolvedValueOnce({ rows: [], unread: [] });
    listServiceHealthInputs.mockRejectedValueOnce(
      new Error("connection refused")
    );

    const { result } = renderHook(() => useServiceHealthInputs(null), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.unread).toEqual([]));

    await client.refetchQueries();

    await waitFor(() =>
      expect(result.current.unread).toEqual([
        expect.objectContaining({
          namespace: null,
          message: expect.stringContaining("connection refused"),
        }),
      ])
    );
  });
});
