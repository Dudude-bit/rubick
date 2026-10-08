import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { useRereadWith } from "./useRereadWith";

const overview = queryKeys.detail("Deployment", "shop", "cart");
const manifest = queryKeys.manifest("Deployment", "shop", "cart");

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(overview, { resourceVersion: "1" });
  const read = vi.fn(async () => `revision ${read.mock.calls.length}`);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => {
      useRereadWith(overview, manifest);
      return useQuery({ queryKey: manifest, queryFn: read });
    },
    { wrapper }
  );
  return { client, read, result };
}

describe("an object's YAML beside its Overview", () => {
  /**
   * A page or a peek with no list mounted showed the old revision for a
   * whole slow poll after its Overview had the new one. Fails if a changed
   * Overview read leaves the YAML where it was.
   */
  it("reads the YAML again when the Overview answers with a changed object", async () => {
    const { client, read, result } = mount();
    await waitFor(() => expect(result.current.data).toBe("revision 1"));

    client.setQueryData(overview, { resourceVersion: "2" });

    await waitFor(() => expect(result.current.data).toBe("revision 2"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  /** Fails if every poll of an unchanged object rereads the YAML too. */
  it("leaves the YAML alone when the Overview answers with the same object", async () => {
    const { client, read, result } = mount();
    await waitFor(() => expect(result.current.data).toBe("revision 1"));

    client.setQueryData(overview, client.getQueryData(overview));
    client.setQueryData(overview, { resourceVersion: "1" });

    expect(read).toHaveBeenCalledTimes(1);
  });
});
