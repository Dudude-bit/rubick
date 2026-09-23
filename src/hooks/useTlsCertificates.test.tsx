import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/commands", () => ({
  commands: { getTlsCertificates: vi.fn() },
}));

import { commands } from "@/lib/commands";
import { useTlsCertificates } from "./useTlsCertificates";

const read = vi.mocked(commands.getTlsCertificates);
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const unread = {
  secretName: "shop-tls",
  certificate: null,
  problem: { says: "secretUnreadable", said: "Not connected to prod" },
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  read.mockReset();
});

describe("the certificates the Gateway and Secret pages read", () => {
  /**
   * The pages read `data?.get(name)`, so a failed read was no entry: the
   * Gateway's listener said "reading certificate" for good and the Secret
   * page drew no certificate at all.
   */
  it("carries a Secret whose read failed as unread, not as still reading", async () => {
    read.mockRejectedValue(new Error("Not connected to prod"));
    const { result } = renderHook(
      () => useTlsCertificates("shop", ["shop-tls"]),
      { wrapper }
    );

    await waitFor(() =>
      expect(result.current?.get("shop-tls")).toEqual(unread)
    );
  });

  /**
   * The vendor pages read the same key; a re-read that failed there and not
   * here would leave the Gateway page stating an expiry the Traefik page
   * calls unread.
   */
  it("marks a Secret unread once its re-read failed, over the answer it had", async () => {
    read.mockResolvedValue([
      { secretName: "shop-tls", certificate: null, problem: null },
    ]);
    const { result } = renderHook(
      () => useTlsCertificates("shop", ["shop-tls"]),
      { wrapper }
    );
    await waitFor(() =>
      expect(result.current?.get("shop-tls")?.problem).toBeNull()
    );

    read.mockRejectedValue(new Error("Not connected to prod"));
    await act(() => client.refetchQueries());

    await waitFor(() =>
      expect(result.current?.get("shop-tls")).toEqual(unread)
    );
  });
});
