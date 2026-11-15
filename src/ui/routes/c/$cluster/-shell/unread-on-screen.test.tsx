import type { ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { readName, readWords, useUnreadOnScreen } from "./unread-on-screen";

const t: T = (section, key, values) => translate("en", section, key, values);

const refusal = {
  code: "PERMISSION_DENIED",
  message: 'deployments.apps "api" is forbidden',
};
const timeout = {
  code: "KUBE_API_ERROR",
  message: "etcdserver: request timed out",
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const onScreen = (
    queryKey: QueryKey,
    queryFn: () => Promise<unknown>,
    enabled = true
  ) =>
    new QueryObserver(client, { queryKey, queryFn, enabled }).subscribe(
      () => {}
    );
  return { client, wrapper, onScreen };
}

describe("the reads on screen the problem count cannot vouch for", () => {
  /**
   * A Deployment page's own read refused, and the strip said "1
   * problem in api" as if everything had been read. Fails if a refused read
   * on screen is missed, called a failure, or outlives the answer after it.
   */
  it("names a read on screen whose latest answer was refused, until it answers", async () => {
    const { client, wrapper, onScreen } = setup();
    let answer: () => Promise<unknown> = () => Promise.reject(refusal);
    onScreen(["deployment", "api", "api"], () => answer());

    const { result } = renderHook(() => useUnreadOnScreen(), { wrapper });
    await waitFor(() =>
      expect(result.current).toEqual([
        {
          key: ["deployment", "api", "api"],
          refused: true,
          error: refusal,
          at: expect.any(Number),
        },
      ])
    );

    answer = () => Promise.resolve({ name: "api" });
    await act(() => client.refetchQueries());
    await waitFor(() => expect(result.current).toEqual([]));
  });

  /**
   * Argo CD's read timing out while the strip said "0 problems".
   * Fails if a failed read is left out, or if a NotFound, a read nothing on
   * screen holds, a hidden surface's read or a usage read is counted.
   */
  it("counts a failure, and not an answer, an unheld read, a hidden one or usage", async () => {
    const { client, wrapper, onScreen } = setup();
    onScreen(["prod", "argocd", "applications"], () => Promise.reject(timeout));
    onScreen(["pod", "shop", "gone"], () =>
      Promise.reject({ code: "NOT_FOUND", message: 'pods "gone" not found' })
    );
    onScreen(["metrics", "pods", "*"], () => Promise.reject(refusal));
    await client
      .fetchQuery({
        queryKey: ["secrets", "*"],
        queryFn: () => Promise.reject(refusal),
      })
      .catch(() => {});
    await client
      .fetchQuery({
        queryKey: ["configmaps", "*"],
        queryFn: () => Promise.reject(refusal),
      })
      .catch(() => {});
    onScreen(["configmaps", "*"], () => Promise.reject(refusal), false);

    const { result } = renderHook(() => useUnreadOnScreen(), { wrapper });
    await waitFor(() =>
      expect(result.current).toEqual([
        {
          key: ["prod", "argocd", "applications"],
          refused: false,
          error: timeout,
          at: expect.any(Number),
        },
      ])
    );
  });

  /** Fails if the strip cannot render where no query client is above it. */
  it("is empty with no query client above it", () => {
    const { result } = renderHook(() => useUnreadOnScreen());
    expect(result.current).toEqual([]);
  });
});

describe("what an unread read is called", () => {
  /** Fails if a read is named by its cache key's raw spelling where the key names a kind. */
  it("names one object by its kind and name, a list by its kind, and anything else by its own words", () => {
    expect(readName(["deployment", "api", "api"], "prod")).toBe(
      "Deployment api"
    );
    expect(readName(["deployments", "*"], "prod")).toBe("Deployments");
    expect(readName(["pod-rows", "shop"], "prod")).toBe("Pods");
    expect(readName(["prod", "argocd", "applications"], "prod")).toBe(
      "argocd applications"
    );
  });
});

describe("what a read the count asks for itself is called", () => {
  /**
   * The hover named "ingress-clients
   * traefik.io/ingress-controller", a cache key nobody reading it knows.
   * Fails if such a read is named by its key, or if any other read loses
   * its name.
   */
  it("names it in words with the controller as the cluster wrote it, and every other read as before", () => {
    expect(
      readWords(["ingress-clients", "traefik.io/ingress-controller"], "prod", t)
    ).toBe("Pods of the ingress controller traefik.io/ingress-controller");
    expect(readWords(["deployment", "api", "api"], "prod", t)).toBe(
      "Deployment api"
    );
  });
});
