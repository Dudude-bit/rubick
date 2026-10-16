import { act, type ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  ClusterOverview,
  GatewayApiDetection,
  GatewayInfo,
} from "@/generated/types";

const commands = vi.hoisted(() => ({
  getClusterOverview: vi.fn(),
  listServiceHealthInputs: vi.fn(),
  listIngressHealthInputs: vi.fn(),
  listAutoscalersIn: vi.fn(),
  listPersistentVolumeClaimsIn: vi.fn(),
  resolveIngressClass: vi.fn(),
  getTlsCertificates: vi.fn(),
  detectGatewayApi: vi.fn(),
  checkListAccess: vi.fn(),
  listGateways: vi.fn(),
  listGatewayClasses: vi.fn(),
  listGatewayRoutesIn: vi.fn(),
  listGatewaysIn: vi.fn(),
  listServiceBacking: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({ commands }));

const { useAttention } = await import("./useAttention");
const { useClusterStore } = await import("@/stores/clusterStore");
const { useWindowActivity } = await import("@/lib/window-activity");
const { REFRESH_INTERVALS, STALE_TIMES } = await import("@/lib/refresh");

const OVERVIEW = {
  problems: [],
  problemsTruncated: 0,
  unconfirmed: [],
  unread: [],
} as unknown as ClusterOverview;

const EMPTY = { rows: [], unread: [] };

const NO_GATEWAY_API: GatewayApiDetection = {
  installed: false,
  bundleVersion: null,
  channel: null,
  mixedBundle: null,
  kinds: [],
};

function wrapper(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset();
  commands.getClusterOverview.mockResolvedValue(OVERVIEW);
  commands.listServiceHealthInputs.mockResolvedValue(EMPTY);
  commands.listIngressHealthInputs.mockResolvedValue(EMPTY);
  commands.listAutoscalersIn.mockResolvedValue(EMPTY);
  commands.listPersistentVolumeClaimsIn.mockResolvedValue(EMPTY);
  commands.detectGatewayApi.mockResolvedValue(NO_GATEWAY_API);
  commands.checkListAccess.mockResolvedValue([]);
  useClusterStore.setState({
    isConnected: true,
    currentContext: "prod",
    namespaceScope: ["shop"],
  });
});

describe("the reads behind Needs attention", () => {
  /**
   * Marco's token may list pods and not autoscalers. The refusal has to
   * reach the list as a kind not checked, with the cluster's code, rather
   * than as a scope with no autoscaler in trouble. Fails if a failed read is
   * handed on as an empty one.
   */
  it("carries a refused list as a kind not checked", async () => {
    commands.listAutoscalersIn.mockRejectedValue({
      code: "PERMISSION_DENIED",
      message: "horizontalpodautoscalers.autoscaling is forbidden",
    });

    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });

    await waitFor(() =>
      expect(
        result.current?.checks.find(
          (check) => check.kind === "HorizontalPodAutoscaler"
        )?.state
      ).toBe("unread")
    );
    const hpa = result.current!.checks.find(
      (check) => check.kind === "HorizontalPodAutoscaler"
    )!;
    expect(hpa.unread[0].code).toBe("PERMISSION_DENIED");
    expect(result.current!.complete).toBe(false);
    expect(commands.listAutoscalersIn).toHaveBeenCalledWith(["shop"]);
  });

  /** Every list answered is the one complete answer, and only once they all have. */
  it("is complete once every list has answered, and not before", async () => {
    let answer: (value: typeof EMPTY) => void = () => {};
    commands.listPersistentVolumeClaimsIn.mockReturnValue(
      new Promise((resolve) => (answer = resolve))
    );

    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() =>
      expect(
        result.current!.checks.filter((check) => check.state !== "read")
      ).toEqual([
        { kind: "PersistentVolumeClaim", state: "reading", unread: [] },
      ])
    );
    expect(result.current!.complete).toBe(false);

    answer(EMPTY);
    await waitFor(() => expect(result.current!.complete).toBe(true));
  });

  /**
   * marco, refused the Gateways list, got "Something went wrong": a lock is
   * a new object on every render, the count depended on it, and the shell
   * writes a changed count to a store, which renders again. Fails if a
   * refused Gateway API read gives the count a new identity per render.
   */
  it("keeps one answer across renders where Gateway API is refused", async () => {
    commands.detectGatewayApi.mockResolvedValue({
      ...NO_GATEWAY_API,
      installed: true,
      kinds: [
        {
          kind: "Gateway",
          plural: "gateways",
          versions: ["v1"],
          readVersion: "v1",
        },
        {
          kind: "HTTPRoute",
          plural: "httproutes",
          versions: ["v1"],
          readVersion: "v1",
        },
      ],
    });
    commands.checkListAccess.mockResolvedValue([
      { resource: "gateways", allowed: false },
      { resource: "httproutes", allowed: false },
    ]);

    const { result, rerender } = renderHook(() => useAttention(), {
      wrapper: wrapper(),
    });

    await waitFor(() =>
      expect(result.current?.checks).toContainEqual(
        expect.objectContaining({ kind: "Gateway", state: "unread" })
      )
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  /**
   * The rail went red over bad-gw while the count every screen keeps said
   * nothing of it. Fails if the Gateways the rail reads stop reaching the
   * count, or discovery that has not answered lets the count call itself
   * whole.
   */
  it("counts a Gateway its controller refused, once Gateway API has answered", async () => {
    const said = (type: string, status: string, reason: string) => ({
      type,
      status,
      reason,
      message: null,
      lastTransitionTime: null,
    });
    const badGw = {
      uid: "",
      name: "bad-gw",
      namespace: "shop",
      apiVersion: "gateway.networking.k8s.io/v1",
      className: "traefik",
      listenerSets: [],
      listenerSetsKnown: true,
      listeners: [],
      addresses: [],
      conditions: [said("Accepted", "False", "ListenersNotValid")],
      generation: 1,
      labels: {},
      annotations: {},
      createdAt: null,
    } as unknown as GatewayInfo;
    let discovered: (value: GatewayApiDetection) => void = () => {};
    commands.detectGatewayApi.mockReturnValue(
      new Promise((resolve) => (discovered = resolve))
    );
    commands.listGateways.mockResolvedValue([badGw]);
    commands.listGatewaysIn.mockResolvedValue({ rows: [badGw], unread: [] });
    commands.listGatewayClasses.mockResolvedValue([
      {
        name: "traefik",
        controllerName: "traefik.io/gateway-controller",
        accepted: true,
        conditions: [],
      },
    ]);

    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });

    await waitFor(() =>
      expect(result.current?.checks).toContainEqual({
        kind: "Gateway",
        state: "reading",
        unread: [],
      })
    );
    expect(result.current!.complete).toBe(false);

    discovered({
      ...NO_GATEWAY_API,
      installed: true,
      kinds: [
        {
          kind: "Gateway",
          plural: "gateways",
          versions: ["v1"],
          readVersion: "v1",
        },
        {
          kind: "GatewayClass",
          plural: "gatewayclasses",
          versions: ["v1"],
          readVersion: "v1",
        },
      ],
    });
    await waitFor(() =>
      expect(
        result.current!.items.map((item) => [item.kind, item.name, item.reason])
      ).toEqual([["Gateway", "bad-gw", "ListenersNotValid"]])
    );
    expect(result.current!.byNamespace.get("shop")).toBe(1);
  });
});

describe("how often the lists behind the count are asked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWindowActivity.setState({
      visible: true,
      focused: true,
      interactionAt: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const asked = () =>
    [
      commands.listServiceHealthInputs,
      commands.listIngressHealthInputs,
      commands.listAutoscalersIn,
      commands.listPersistentVolumeClaimsIn,
    ].map((command) => command.mock.calls.length);

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /**
   * The sidebar badge and the status bar on a page about something else.
   * Fails if the shell asks the four lists faster than once a minute, which
   * is what put every Service in the cluster on the wire every ten seconds
   * from the Nodes page, or keeps asking from a hidden window.
   */
  it("asks once a minute from the shell, and not while the window is hidden", async () => {
    renderHook(() => useAttention(), { wrapper: wrapper() });
    await advance(0);
    expect(asked()).toEqual([1, 1, 1, 1]);

    await advance(REFRESH_INTERVALS.shell - 1_000);
    expect(asked()).toEqual([1, 1, 1, 1]);
    await advance(1_001);
    expect(asked()).toEqual([2, 2, 2, 2]);

    act(() => {
      useWindowActivity.setState({ visible: false, focused: false });
    });
    await advance(REFRESH_INTERVALS.shell * 5);
    expect(asked()).toEqual([2, 2, 2, 2]);
  });

  /**
   * Sam's Overview: one list of Services sat a whole minute on the cluster
   * while the rest answered, and the count went on saying every Service was
   * checked. Fails if a re-read waiting past the slow-read grace leaves the
   * kind read, or if it stays "still reading" once the answer lands.
   */
  it("names a list still reading once its re-read waits past the slow-read grace", async () => {
    const { SLOW_READ_MS } = await import("@/lib/read-deadline");
    const { result } = renderHook(() => useAttention({ refresh: "slow" }), {
      wrapper: wrapper(),
    });
    await advance(0);
    expect(result.current?.complete).toBe(true);
    let answer: (value: typeof EMPTY) => void = () => {};
    commands.listServiceHealthInputs.mockReturnValue(
      new Promise((resolve) => (answer = resolve))
    );
    const service = () =>
      result.current?.checks.find((check) => check.kind === "Service")?.state;

    await advance(REFRESH_INTERVALS.slow + SLOW_READ_MS - 1_000);
    expect(service()).toBe("read");
    await advance(2_000);
    expect(service()).toBe("reading");
    expect(result.current?.complete).toBe(false);

    await act(async () => answer(EMPTY));
    await advance(0);
    expect(service()).toBe("read");
  });

  /** Fails if the Overview, the page about these lists, reads them at the shell's minute. */
  it("asks at the Overview's own rate while the Overview reads it", async () => {
    renderHook(() => useAttention({ refresh: "slow" }), {
      wrapper: wrapper(),
    });
    await advance(0);
    expect(asked()).toEqual([1, 1, 1, 1]);

    await advance(REFRESH_INTERVALS.slow + 1);
    expect(asked()).toEqual([2, 2, 2, 2]);
  });

  /**
   * Opening the Overview draws the count the shell already holds, at once.
   * Fails if the two ask under different keys: the Overview would open on
   * "still reading" and send every list a second time.
   */
  it("opens the Overview on the shell's answer without asking again", async () => {
    const shared = wrapper(
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: STALE_TIMES.slow },
        },
      })
    );
    renderHook(() => useAttention(), { wrapper: shared });
    await advance(0);
    const fromShell = asked();

    const { result } = renderHook(() => useAttention({ refresh: "slow" }), {
      wrapper: shared,
    });

    expect(result.current?.complete).toBe(true);
    await advance(0);
    expect(asked()).toEqual(fromShell);
  });
});
