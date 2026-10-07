import { act, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ComponentType } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type {
  DaemonSetInfo,
  PodRow,
  PodStart,
  Rollout,
  StatefulSetInfo,
} from "@/generated/types";
import { renderWithRouter } from "@/test/render";

const pods = vi.hoisted(() => ({ rows: [] as PodRow[] }));

vi.mock("@/stores/clusterStore", () => {
  const state = {
    currentNamespace: "shop",
    namespaceScope: ["shop"],
    isConnected: true,
    contexts: [],
  };
  return {
    useClusterStore: vi.fn(<T,>(selector?: (s: typeof state) => T) =>
      typeof selector === "function" ? selector(state) : state
    ),
  };
});

vi.mock("@/hooks/usePodsWithMetrics", () => ({
  usePodsWithMetrics: () => ({
    data: pods.rows,
    podStatus: null,
    podUnread: [],
    refetchPodMetrics: vi.fn(),
  }),
}));

vi.mock("@/hooks/useWatchedList", () => ({
  useWatchedList: () => ({ live: true, refresh: false, resyncing: false }),
}));

const { StatefulSetList } =
  await import("../statefulsets/-components/StatefulSetList");
const { DaemonSetList } =
  await import("../daemonsets/-components/DaemonSetList");

const SHORT: Rollout = { state: "short", available: 1, desired: 2 };

/** A pod row as the Rust stream sends it, with only what the verdict reads filled in. */
const row = (name: string, start: PodStart) =>
  ({ name, namespace: "shop", labels: {}, start }) as PodRow;

const startingFor = (ms: number): PodStart => ({
  state: "starting",
  until: new Date(Date.now() + ms).toISOString(),
});

const SETS = [
  {
    kind: "StatefulSet",
    List: StatefulSetList as ComponentType,
    plural: "statefulsets",
    list: "list_statefulsets_in",
    row: {
      name: "web",
      namespace: "shop",
      replicas: { desired: 2, ready: 1, current: 2, updated: 2 },
      rollout: SHORT,
      rolloutPlan: {
        strategy: "ordered",
        replicas: 2,
        start: 0,
        partition: 0,
        unavailable: 1,
      },
      containerImages: [],
      templateAnnotations: {},
      generation: 2,
      observedGeneration: 2,
      createdAt: "2026-10-01T00:00:00Z",
    } satisfies StatefulSetInfo,
    serving: "web-0",
    coming: "web-1",
  },
  {
    kind: "DaemonSet",
    List: DaemonSetList as ComponentType,
    plural: "daemonsets",
    list: "list_daemonsets_in",
    row: {
      name: "agent",
      namespace: "shop",
      desired: 2,
      current: 2,
      ready: 1,
      updated: 2,
      rollout: SHORT,
      rolloutPlan: {
        strategy: "rolling",
        replicas: 2,
        surge: 0,
        unavailable: 1,
      },
      containerImages: [],
      templateAnnotations: {},
      generation: 1,
      observedGeneration: 1,
      createdAt: "2026-10-01T00:00:00Z",
    } satisfies DaemonSetInfo,
    serving: "agent-x7k2p",
    coming: "agent-q9w4z",
  },
] as const;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function open(set: (typeof SETS)[number], newPod: PodStart) {
  pods.rows = [
    row(set.serving, { state: "settled" }),
    row(set.coming, newPod),
    row(`${set.row.name}-api-5d4c8-x9z2q`, { state: "failing" }),
  ];
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === set.list) return { rows: [set.row], unread: [] };
    return undefined;
  });
  await renderWithRouter(<set.List />, {
    at: `/c/prod/${set.plural}`,
    route: `/c/$cluster/${set.plural}`,
  });
  await screen.findByText(set.row.name);
}

const status = () =>
  screen.getByText(/^(Progressing|Degraded)$/).textContent ?? "";

describe.each(SETS)("the $kind list while one is scaled up", (set) => {
  /**
   * Lena scaled one up and the list read amber Degraded while the new pod
   * was being created and the first served: the row's counts cannot tell
   * the two apart, and only the page asked the pods. Fails if the list does
   * not read the pods' starts as its page does, or keeps calling it coming
   * up once the start has run out of time.
   */
  it("reads Progressing while the new pod starts, and Degraded once its start runs out", async () => {
    await open(set, startingFor(25_000));
    expect(status()).toBe("Progressing");

    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(status()).toBe("Degraded");
  });

  /**
   * A new pod that cannot pull its image is the fault the counts suspected.
   * Fails if a stuck pod reads as one coming up.
   */
  it("reads Degraded where the new pod is stuck", async () => {
    await open(set, { state: "failing" });
    expect(status()).toBe("Degraded");
  });
});
