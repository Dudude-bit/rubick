import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { queryKeys } from "@/lib/query-keys";
import {
  useHeldNotFound,
  useHeldOwner,
  useReadBehind,
} from "@/hooks/useHeldRead";

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
        { rows: [{ uid: "u" }] },
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
        { rows: [{ uid: "u" }] },
        { updatedAt: 3_000 }
      );
    }, 4_000);
    expect(behind).toBe(false);
  });
});

describe("useHeldNotFound", () => {
  const NOT_FOUND = Object.assign(new Error('pods "netd-xx2b5" not found'), {
    code: "NOT_FOUND",
  });
  const mount = (rows: unknown[]) => {
    const client = new QueryClient();
    client.setQueryData(
      queryKeys.objectWatch("Pod", "kube-system", "netd-xx2b5"),
      { rows },
      { updatedAt: 1_000 }
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(
      ({ at }: { at: number }) =>
        useHeldNotFound(
          "Pod",
          "kube-system",
          "netd-xx2b5",
          { error: NOT_FOUND, errorUpdatedAt: at },
          ["connections", "Pod", "kube-system", "netd-xx2b5"]
        ),
      { wrapper, initialProps: { at: 2_000 } }
    );
    return { view, invalidate };
  };

  /**
   * netd-xx2b5's page, its pod deleted 40 minutes before, flipped between
   * "does not exist" and a skeleton 5 times a second: the watch on its name
   * answering "nothing here" was read as "it was here", and every NotFound
   * of its connections asked for the pod again. Fails if an empty watch
   * answer holds a NotFound back.
   */
  it("takes a NotFound beside a watch that lists nothing under the name", () => {
    const { view, invalidate } = mount([]);
    expect(view.result.current).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  /** Fails if the object is asked for again on every NotFound of a read about it rather than once per sighting of it. */
  it("asks for the object once per sighting, however often the read answers NotFound", () => {
    const { view, invalidate } = mount([{ name: "netd-xx2b5" }]);
    view.rerender({ at: 3_000 });
    view.rerender({ at: 4_000 });
    view.rerender({ at: 5_000 });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("useHeldOwner", () => {
  const otherWith = (answeredFor: string | undefined) => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.detail(KIND, "lab", "api"), { uid: "u" });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(
      () => useHeldOwner(KIND, "lab", "api", { answeredFor, at: 1 }, ["pods"]),
      { wrapper }
    ).result.current;
  };

  /** The pods read while the Deployment could not be read named no uid, and the peek dropped them as another's. Fails if an unnamed answer is held as another object's. */
  it("takes pods read by name, holds another uid's", () => {
    expect(otherWith("")).toBe(false);
    expect(otherWith("u")).toBe(false);
    expect(otherWith("someone-else")).toBe(true);
  });
});
