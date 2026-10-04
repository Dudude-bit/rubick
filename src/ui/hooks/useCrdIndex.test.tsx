import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    listCrds: vi.fn(async () => [
      {
        group: "argoproj.io",
        crds: [
          {
            name: "applications.argoproj.io",
            group: "argoproj.io",
            kind: "Application",
          },
        ],
      },
    ]),
  },
}));

import { peekMutationKeys } from "@/components/resources/peek-actions";
import { commands } from "@/lib/commands";
import { Crds } from "@/routes/c/$cluster/(cluster)/customresourcedefinitions/-components/Crds";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { useCrdIndex } from "./useCrdIndex";

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.mocked(commands.listCrds).mockClear();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

/**
 * The index every reference resolves through and the CRD page read the same
 * list under `crd-index` and `["crds", "grouped"]`, so a CRD deleted on the
 * page stayed a link everywhere else for ten minutes.
 */
describe("the CRD index", () => {
  /** Fails if the page and the index key the list apart. */
  it("is the list the CRD page reads, asked for once", async () => {
    await renderWithRouter(<Crds />, {
      client,
      at: "/c/prod/customresourcedefinitions",
      route: "/c/$cluster/customresourcedefinitions",
    });
    const { result } = renderHook(() => useCrdIndex(), { wrapper });

    await waitFor(() =>
      expect(result.current.crdFor("argoproj.io", "Application")).toBe(
        "applications.argoproj.io"
      )
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(commands.listCrds).toHaveBeenCalledTimes(1);
  });

  /** Fails if a CRD deleted from the peek leaves the index untouched. */
  it("goes stale when a CRD is deleted from the peek", async () => {
    const { result } = renderHook(() => useCrdIndex(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    for (const queryKey of peekMutationKeys("CustomResourceDefinition")) {
      await client.invalidateQueries({ queryKey });
    }
    expect(commands.listCrds).toHaveBeenCalledTimes(2);
  });
});
