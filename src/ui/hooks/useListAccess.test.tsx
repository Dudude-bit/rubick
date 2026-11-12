import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ListAccess, ListQuery } from "@/generated/types";
import { credentialsRenewed } from "@/lib/credentials";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";

const checkListAccess = vi.hoisted(() =>
  vi.fn<(queries: ListQuery[], namespaces: string[]) => Promise<ListAccess[]>>()
);

vi.mock("@/lib/commands", () => ({ commands: { checkListAccess } }));

const { askListAccess, useListableIn, useLocks } =
  await import("./useListAccess");

const CORE_PODS = { group: "", resource: "pods", namespaced: true };
const POD_METRICS = {
  group: "metrics.k8s.io",
  resource: "pods",
  namespaced: true,
};

/** Marco in team-checkout: the core kinds, and nothing of any other group. */
const coreOnly = async (queries: ListQuery[], namespaces: string[]) =>
  queries.map((query) => ({
    resource: query.resource,
    allowed: query.group === "" && namespaces[0] === "team-checkout",
  }));

function oneCache() {
  const client = testQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  checkListAccess.mockReset();
  useClusterStore.setState({
    isConnected: true,
    currentContext: "prod",
    namespaceScope: [],
    contexts: [{ name: "prod", namespace: "team-checkout" } as never],
  });
});

describe("where a refused kind may be listed instead", () => {
  /**
   * Core `pods` and `pods.metrics.k8s.io` share a plural. Keyed by it, the
   * second list was handed the first one's cached answer and offered a
   * namespace where it is refused as well.
   */
  it("answers a kind from its own review, not from a namesake's of the same plural", async () => {
    checkListAccess.mockImplementation(coreOnly);
    const wrapper = oneCache();

    const core = renderHook(() => useListableIn(CORE_PODS), { wrapper });
    await waitFor(() =>
      expect(core.result.current.readableIn).toEqual(["team-checkout"])
    );

    const metrics = renderHook(() => useListableIn(POD_METRICS), { wrapper });
    await waitFor(() =>
      expect(metrics.result.current.refusedIn).toEqual(["team-checkout"])
    );
    expect(metrics.result.current.readableIn).toEqual([]);
    expect(checkListAccess).toHaveBeenCalledWith(
      [POD_METRICS],
      ["team-checkout"]
    );
  });

  /** One batch that holds both namesakes locks each on its own answer. */
  it("keeps two kinds of one plural apart inside one review", async () => {
    useClusterStore.setState({ namespaceScope: ["team-checkout"] });
    checkListAccess.mockImplementation(coreOnly);
    const both = [CORE_PODS, POD_METRICS];

    const { result } = renderHook(() => useLocks(both), {
      wrapper: oneCache(),
    });

    await waitFor(() =>
      expect(result.current.get(POD_METRICS)).toEqual({ says: "refused" })
    );
    expect(result.current.get(CORE_PODS)).toBeUndefined();
  });
});

describe("a lock while its question is asked again", () => {
  /**
   * EKS renews its token every quarter of an hour, and a renewal asks every
   * rights question again. With nothing held meanwhile, the sidebar's locks
   * and the namespaces a refused kind may be listed in went out with each
   * renewal and came back when the reviews answered. Fails if either is
   * dropped while the same question is out again, or if the answer to one
   * scope's question is shown for another's.
   */
  it("stays, with where the kind may be listed instead, through a credential renewal", async () => {
    checkListAccess.mockImplementation(coreOnly);
    const { result } = renderHook(() => useLocks([CORE_PODS]), {
      wrapper: oneCache(),
    });
    const lock = {
      says: "clusterWide",
      readableIn: ["team-checkout"],
      refusedIn: [],
      unasked: false,
    };
    await waitFor(() => expect(result.current.get(CORE_PODS)).toEqual(lock));

    const asked = checkListAccess.mock.calls.length;
    checkListAccess.mockImplementation(() => new Promise(() => {}));
    act(() => credentialsRenewed());
    await waitFor(() =>
      expect(checkListAccess.mock.calls.length).toBe(asked + 2)
    );
    expect(result.current.get(CORE_PODS)).toEqual(lock);

    act(() => useClusterStore.setState({ namespaceScope: ["team-payments"] }));
    expect(result.current.get(CORE_PODS)).toBeUndefined();
  });
});

describe("matching the authorizer's answers to the questions", () => {
  const TRAEFIK = { group: "traefik.io", resource: "ingressroutes" };
  const CONTAINO = { group: "traefik.containo.us", resource: "ingressroutes" };
  const asked = [TRAEFIK, CONTAINO].map((kind) => ({
    ...kind,
    namespaced: true,
  }));

  /**
   * An answer carries only its plural. Filed under it, the later of two
   * namesakes overwrote the earlier, and a vendor served under the allowed
   * group was drawn as refused.
   */
  it("takes each answer for the question in its position", async () => {
    checkListAccess.mockResolvedValue([
      { resource: "ingressroutes", allowed: true },
      { resource: "ingressroutes", allowed: false },
    ]);

    const answers = await askListAccess(asked, []);

    expect(answers.get(TRAEFIK)).toBe(true);
    expect(answers.get(CONTAINO)).toBe(false);
  });

  /**
   * "Could not ask" is not "refused": an answer that is missing, or that
   * names another kind than the one asked in its place, is no answer.
   */
  it("holds an answer that does not line up with its question as unasked", async () => {
    checkListAccess.mockResolvedValue([
      { resource: "middlewares", allowed: false },
    ]);

    const answers = await askListAccess(asked, []);

    expect(answers.get(TRAEFIK)).toBeNull();
    expect(answers.get(CONTAINO)).toBeNull();
  });
});
