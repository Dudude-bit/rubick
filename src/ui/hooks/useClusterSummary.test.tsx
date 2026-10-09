/**
 * The chrome's counts come from the cluster-wide overview, which a token
 * without cluster read rights is refused. A refusal must leave the counts
 * unknown (`null`), never fold to `0` — the status bar and the namespace
 * picker draw "—" from that null, so a scoped user is never told their
 * cluster is empty and healthy while the Overview page says "no access".
 */

import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { peekMutationKeys } from "@/routes/c/$cluster/-peek/peek-actions";
import { setTransport, transport } from "@/lib/transport";
import { fakeTransport } from "@/lib/transport/fake";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  AutoscalerInfo,
  ClusterProblem,
  ServiceHealthInputs,
} from "@/generated/types";
import { useAttention } from "./useAttention";
import { useClusterSummary } from "./useClusterSummary";

// Behind the real command wrapper, which is what remembers a refusal.
const getClusterOverview = vi.fn();
const listNamespaces = vi.fn();
/** The four lists Needs attention reads beside the overview, per scope. */
const lists = {
  services: [] as ServiceHealthInputs[],
  autoscalers: [] as AutoscalerInfo[],
};
const inScope = <R,>(
  rows: R[],
  namespaceOf: (row: R) => string | null,
  scope: unknown
) => ({
  rows: Array.isArray(scope)
    ? rows.filter((row) => scope.includes(namespaceOf(row)))
    : rows,
  unread: [],
});
const real = transport();
setTransport(
  fakeTransport({
    get_cluster_overview: (args) => getClusterOverview(args?.scope),
    list_namespaces: () => listNamespaces(),
    list_service_health_inputs: (args) =>
      inScope(lists.services, (row) => row.namespace, args?.scope),
    list_ingress_health_inputs: () => ({ rows: [], unread: [] }),
    list_autoscalers_in: (args) =>
      inScope(
        lists.autoscalers,
        (row) => row.autoscaler.namespace,
        args?.scope
      ),
    list_persistent_volume_claims_in: () => ({ rows: [], unread: [] }),
  }).transport
);
afterAll(() => setTransport(real));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  getClusterOverview.mockReset();
  listNamespaces.mockReset();
  lists.services = [];
  lists.autoscalers = [];
  // Each test is a connection of its own: a refusal is remembered per one.
  useClusterStore.setState((s) => ({
    isConnected: true,
    currentContext: "prod",
    namespaceScope: [],
    connectionAttemptId: s.connectionAttemptId + 1,
  }));
});

/**
 * The picker's namespaces are the list Helm's forms offer, read once under
 * one key; a namespace deleted from the peek has to leave the picker too.
 * Fails if the summary keys the list where a Namespace mutation cannot reach.
 */
describe("the namespaces the window offers", () => {
  it("are read again once a namespace is deleted from the peek", async () => {
    getClusterOverview.mockResolvedValue({
      namespaces: [],
      problems: [],
      problemsTruncated: 0,
      unread: [],
      counts: { pods: 0 },
    } as never);
    listNamespaces.mockResolvedValue([{ name: "team-a" }] as never);
    const { result } = renderHook(() => useClusterSummary(), { wrapper });
    await waitFor(() => expect(result.current.namespaces).toHaveLength(1));

    listNamespaces.mockResolvedValue([] as never);
    for (const queryKey of peekMutationKeys("Namespace")) {
      await client.invalidateQueries({ queryKey });
    }
    await waitFor(() => expect(result.current.namespaces).toHaveLength(0));
  });
});

describe("cluster summary counts when the overview is refused", () => {
  it("leaves the counts unknown, keeping the namespace names it can still read", async () => {
    getClusterOverview.mockRejectedValue("pods is forbidden (code: 403)");
    // listNamespaces is a separate read and can still succeed.
    listNamespaces.mockResolvedValue([
      { name: "team-a" },
      { name: "team-b" },
    ] as never);

    const { result } = renderHook(() => useClusterSummary({ problems: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.podCount).toBeNull();
    expect(result.current.namespaces.map((n) => n.name).sort()).toEqual([
      "team-a",
      "team-b",
    ]);
    // The names are known; the counts inside them are not — never 0.
    for (const ns of result.current.namespaces) {
      expect(ns.podCount).toBeNull();
      expect(ns.problems).toBeNull();
    }
  });

  /**
   * The overview now answers when only its pods were refused, with no
   * namespace breakdown. Fails if a namespace missing from that breakdown
   * reads as holding zero pods.
   */
  it("leaves pod counts unknown when the answer's pods were refused", async () => {
    getClusterOverview.mockResolvedValue({
      namespaces: [],
      problems: [],
      problemsTruncated: 0,
      unread: [
        {
          kind: "Pod",
          namespace: null,
          code: "PERMISSION_DENIED",
          message: "pods is forbidden",
        },
      ],
      counts: { pods: null },
    } as never);
    listNamespaces.mockResolvedValue([{ name: "team-a" }] as never);

    const { result } = renderHook(() => useClusterSummary(), { wrapper });
    await waitFor(() => expect(result.current.namespaces).toHaveLength(1));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.podCount).toBeNull();
    expect(result.current.namespaces[0].podCount).toBeNull();
  });

  it("reports the real counts when the overview answers", async () => {
    getClusterOverview.mockResolvedValue({
      namespaces: [{ name: "team-a", podCount: 3, problemCount: 1 }],
      problems: [{ namespace: "team-a" }],
      problemsTruncated: 0,
      unread: [],
      counts: { pods: 3 },
    } as never);
    listNamespaces.mockResolvedValue([{ name: "team-a" }] as never);

    const { result } = renderHook(() => useClusterSummary({ problems: true }), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.namespaces[0].problems?.complete).toBe(true)
    );
    expect(result.current.namespaces[0].podCount).toBe(3);
    expect(result.current.namespaces[0].problems?.total).toBe(1);
  });

  /**
   * The backend ranks its problems worst first and keeps fifty. Counted from
   * that list, a namespace whose warnings fell past the cut read "0", and the
   * status bar said "50+" about a number the backend had counted exactly.
   */
  it("counts the problems the ranked list dropped", async () => {
    getClusterOverview.mockResolvedValue({
      namespaces: [
        { name: "prod", podCount: 50, problemCount: 50 },
        { name: "dev", podCount: 1, problemCount: 1 },
      ],
      problems: Array.from({ length: 50 }, () => ({ namespace: "prod" })),
      problemsTruncated: 1,
      unread: [],
      counts: { pods: 51 },
    } as never);
    listNamespaces.mockResolvedValue([
      { name: "prod" },
      { name: "dev" },
    ] as never);

    const { result } = renderHook(() => useClusterSummary({ problems: true }), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.namespaces[0].problems).not.toBeNull()
    );
    const dev = result.current.namespaces.find((ns) => ns.name === "dev");
    expect(dev?.problems?.total).toBe(1);
  });
});

describe("who asks for the whole cluster", () => {
  /**
   * Marco, scoped to his one namespace: the picker is mounted on every
   * screen and asked for the whole cluster every ten seconds while shut,
   * refused every time. Fails if a summary nobody is reading asks at all.
   */
  it("asks only while someone reads the counts", async () => {
    getClusterOverview.mockResolvedValue({
      namespaces: [],
      problems: [],
      problemsTruncated: 0,
      unread: [],
      counts: { pods: 3 },
    } as never);
    listNamespaces.mockResolvedValue([] as never);

    const { result, rerender } = renderHook(
      ({ open }) => useClusterSummary({ enabled: open }),
      { wrapper, initialProps: { open: false } }
    );
    await waitFor(() => expect(listNamespaces).toHaveBeenCalled());
    expect(getClusterOverview).not.toHaveBeenCalled();
    expect(result.current.podCount).toBeNull();

    rerender({ open: true });
    await waitFor(() => expect(result.current.podCount).toBe(3));
    expect(getClusterOverview).toHaveBeenCalledWith(null);
  });
});

describe("counts once the whole cluster refused", () => {
  /**
   * A reader who may list namespaces but read pods only in their own: the
   * window's overview already counts that one. Fails if its row loses the
   * count, or if another namespace's row claims one.
   */
  it("counts the window's own namespace from its own overview, and no other", async () => {
    useClusterStore.setState({ namespaceScope: ["team-checkout"] });
    getClusterOverview.mockImplementation(async (scope) => {
      if (scope === null) throw "pods is forbidden (code: 403)";
      return {
        namespaces: [],
        problems: [{ namespace: "team-checkout" }],
        problemsTruncated: 0,
        unread: [],
        counts: { pods: 4 },
      } as never;
    });
    listNamespaces.mockResolvedValue([
      { name: "team-checkout" },
      { name: "shop" },
    ] as never);

    const { result } = renderHook(() => useClusterSummary({ problems: true }), {
      wrapper,
    });

    await waitFor(() =>
      expect(
        result.current.namespaces.find((ns) => ns.name === "team-checkout")
      ).toMatchObject({ podCount: 4, problems: { total: 1 } })
    );
    expect(result.current.refused).toBe(true);
    expect(result.current.podCount).toBeNull();
    expect(
      result.current.namespaces.find((ns) => ns.name === "shop")
    ).toMatchObject({ podCount: null, problems: null });
  });
});

describe("the count beside a namespace and the count on its Overview", () => {
  const CHECKOUT = ["team-checkout"];
  const SHOP = ["shop"];
  const problem = (
    kind: string,
    name: string,
    namespace: string,
    reason: string
  ): ClusterProblem => ({
    severity: "critical",
    kind,
    name,
    namespace,
    reason,
    detail: null,
    since: "2026-10-06T21:00:00Z",
    restarts: null,
    foldedPods: null,
  });
  const backend = [
    problem(
      "Pod",
      "checkout-worker-6d9f7b8c4-q2x7m",
      "team-checkout",
      "CreateContainerConfigError"
    ),
    problem(
      "Deployment",
      "checkout-worker",
      "team-checkout",
      "ProgressDeadlineExceeded"
    ),
    problem("Pod", "checkout-55cbfdc66-sjfpd", "shop", "CrashLoopBackOff"),
  ];

  /**
   * Sam's picker said "team-checkout 4 · 2 problems" beside an Overview and
   * a status bar that said 3, and Dana's said one fewer than her Overview in
   * shop: the picker counted the backend's pods, workloads, Jobs and nodes,
   * and not the Service with no endpoints or the autoscaler that cannot read
   * its metrics. Fails if the picker and the namespace's Overview count the
   * same namespace differently.
   */
  it("is the number the namespace's own Overview counts", async () => {
    getClusterOverview.mockImplementation(async (scope: string[] | null) => ({
      namespaces:
        scope === null
          ? [
              { name: "team-checkout", podCount: 4, problemCount: 2 },
              { name: "shop", podCount: 14, problemCount: 1 },
            ]
          : [],
      problems: backend.filter(
        (row) => scope === null || scope.includes(row.namespace ?? "")
      ),
      problemsTruncated: 0,
      unread: [],
      counts: { pods: scope === null ? 18 : 4 },
    }));
    listNamespaces.mockResolvedValue([
      { name: "team-checkout" },
      { name: "shop" },
    ] as never);
    lists.services = [
      {
        namespace: "team-checkout",
        groups: [
          {
            names: ["checkout-api"],
            type: "ClusterIP",
            selectorless: false,
            ready: 0,
            draining: 0,
            notReady: 0,
            unrouted: 0,
          },
        ],
      },
    ];
    lists.autoscalers = [
      {
        autoscaler: {
          kind: "HorizontalPodAutoscaler",
          name: "cart",
          namespace: "shop",
          existence: "present",
          facts: {
            kind: "autoscaler",
            minReplicas: 2,
            maxReplicas: 5,
            currentReplicas: 2,
            desiredReplicas: 0,
            metrics: [],
            conditions: [
              {
                type: "ScalingActive",
                status: "False",
                reason: "FailedGetResourceMetric",
                message:
                  "the HPA was unable to compute the replica count: failed to get cpu utilization",
                lastTransitionTime: "2026-10-06T20:00:00Z",
              },
            ],
            lastScaleTime: null,
          },
        },
        target: {
          kind: "Deployment",
          name: "cart",
          namespace: "shop",
          existence: "notChecked",
          facts: null,
        },
      },
    ];

    const { result } = renderHook(
      () => ({
        picker: useClusterSummary({ problems: true }),
        checkout: useAttention({ scope: CHECKOUT }),
        shop: useAttention({ scope: SHOP }),
      }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.checkout?.complete).toBe(true);
      expect(result.current.shop?.complete).toBe(true);
      expect(
        result.current.picker.namespaces.every((ns) => ns.problems?.complete)
      ).toBe(true);
    });
    const picked = (name: string) =>
      result.current.picker.namespaces.find((ns) => ns.name === name)?.problems;
    expect(picked("team-checkout")).toEqual({
      total: result.current.checkout!.total,
      complete: true,
      worst: "err",
    });
    expect(picked("team-checkout")?.total).toBe(3);
    expect(picked("shop")).toEqual({
      total: result.current.shop!.total,
      complete: true,
      worst: "err",
    });
    expect(picked("shop")?.total).toBe(2);
  });

  /**
   * The thesis for the picker: a kind the cluster would not list in a
   * namespace leaves that namespace's count short, and the row says so.
   * Fails if a count with a kind unread passes for the whole count.
   */
  it("is not complete for a namespace a kind could not be read in", async () => {
    getClusterOverview.mockResolvedValue({
      namespaces: [
        { name: "team-checkout", podCount: 4, problemCount: 0 },
        { name: "shop", podCount: 14, problemCount: 0 },
      ],
      problems: [],
      problemsTruncated: 0,
      unread: [
        {
          kind: "DaemonSet",
          namespace: "team-checkout",
          code: "PERMISSION_DENIED",
          message: "daemonsets.apps is forbidden",
        },
      ],
      counts: { pods: 18 },
    } as never);
    listNamespaces.mockResolvedValue([
      { name: "team-checkout" },
      { name: "shop" },
    ] as never);

    const { result } = renderHook(() => useClusterSummary({ problems: true }), {
      wrapper,
    });

    await waitFor(() =>
      expect(
        result.current.namespaces.find((ns) => ns.name === "shop")?.problems
      ).toEqual({ total: 0, complete: true, worst: null })
    );
    expect(
      result.current.namespaces.find((ns) => ns.name === "team-checkout")
        ?.problems
    ).toEqual({ total: 0, complete: false, worst: null });
  });
});
