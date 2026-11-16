import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useKnownCount } from "./known-count";

const withClient = (client: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };

const answered = (n: number) => ({
  rows: Array.from({ length: n }, (_, i) => ({ name: `sc-${i}` })),
  unread: [],
});

describe("the row count a loading list holds its skeleton to", () => {
  /**
   * Storage Classes has no sidebar count and drew eight skeleton rows for
   * four. Fails if a kind the sidebar does not count stops using the last
   * list of it the cache read, or invents a count where none was read.
   */
  it("falls back to the newest list of the kind that was read, and to nothing before one", () => {
    const client = new QueryClient();
    const kind = ResourceType.StorageClass;
    const count = () =>
      renderHook(() => useKnownCount(kind), { wrapper: withClient(client) })
        .result.current;

    expect(count()).toBeNull();

    client.setQueryData(queryKeys.resources(kind, null), answered(4));
    expect(count()).toBe(4);
  });
});
