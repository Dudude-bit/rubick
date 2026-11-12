import { describe, expect, it } from "vite-plus/test";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { queryKeys } from "@/lib/query-keys";
import { useReadBehind } from "@/hooks/useHeldRead";

const KIND = "Deployment";

function behindWith(seed: (client: QueryClient) => void, podsAt: number) {
  const client = new QueryClient();
  seed(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useReadBehind(KIND, "shop", "api", { at: podsAt, contradicted: true }, [
        "pods",
      ]),
    { wrapper }
  ).result.current;
}

describe("useReadBehind", () => {
  /**
   * Sam's drains: the header followed the Deployment's watch while the note
   * kept "its pods say coming up, 0 of 1 ready" for 0.44 s, because the pods
   * were only compared with the page's slower read. Fails if a pods read
   * older than the watch's delivery is not behind.
   */
  it("holds a pods read older than the object's watch delivery as behind", () => {
    const behind = behindWith((client) => {
      client.setQueryData(
        queryKeys.detail(KIND, "shop", "api"),
        { uid: "u" },
        {
          updatedAt: 1_000,
        }
      );
      client.setQueryData(
        queryKeys.objectWatch(KIND, "shop", "api"),
        { uid: "u" },
        { updatedAt: 3_000 }
      );
    }, 2_000);
    expect(behind).toBe(true);
  });

  /** Fails if a pods read newer than every reading of the object is held back. */
  it("takes a pods read newer than both readings of the object", () => {
    const behind = behindWith((client) => {
      client.setQueryData(
        queryKeys.detail(KIND, "shop", "api"),
        { uid: "u" },
        {
          updatedAt: 1_000,
        }
      );
      client.setQueryData(
        queryKeys.objectWatch(KIND, "shop", "api"),
        { uid: "u" },
        { updatedAt: 3_000 }
      );
    }, 4_000);
    expect(behind).toBe(false);
  });
});
