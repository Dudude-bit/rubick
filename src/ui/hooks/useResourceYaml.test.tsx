import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: { getManifest: vi.fn(async () => "kind: Pod\n") },
}));

import { queryKeys } from "@/lib/query-keys";
import { useResourceYaml } from "./useResourceYaml";

/**
 * A detail page's YAML tab and the peek's read one manifest, and a mutation
 * from the peek marks it stale by the same builder. Fails if the page keeps
 * it under a key of its own again (it was `pod-yaml` beside `peek-yaml`).
 */
describe("a detail page's manifest", () => {
  it("is kept where the peek and its mutations look for it", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => useResourceYaml("Pod", "api-7bcd", "shop", "yaml"),
      { wrapper }
    );

    await waitFor(() => expect(result.current.data).toBe("kind: Pod\n"));
    expect(
      client.getQueryData(queryKeys.manifest("Pod", "shop", "api-7bcd"))
    ).toBe("kind: Pod\n");
  });
});
