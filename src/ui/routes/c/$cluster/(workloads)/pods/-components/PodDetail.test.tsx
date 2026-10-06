import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import type { PodInfo, ReplicaSetInfo } from "@/generated/types";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithRouter } from "@/test/render";
import { PodDetail } from "./PodDetail";

const NAME = "cart-9df89489c-n6rzf";

const POD = {
  name: NAME,
  namespace: "shop",
  uid: "pod-uid",
  status: {
    phase: "Running",
    display: "Running",
    ready: true,
    conditions: [],
    message: null,
    reason: null,
  },
  nodeName: "node01",
  podIp: "10.0.0.7",
  hostIp: "10.0.0.2",
  containers: [],
  initContainers: [],
  labels: { app: "cart" },
  annotations: {},
  createdAt: "2026-10-06T00:00:00Z",
  restartCount: 0,
  lastRestartAt: null,
  cpuRequests: null,
  cpuLimits: null,
  memoryRequests: null,
  memoryLimits: null,
  ownerReferences: [
    {
      api_version: "apps/v1",
      kind: "ReplicaSet",
      name: "cart-9df89489c",
      uid: "rs-uid",
      controller: true,
    },
  ],
  volumes: [],
  serviceAccountName: null,
} as unknown as PodInfo;

const REPLICA_SET = {
  name: "cart-9df89489c",
  namespace: "shop",
  uid: "rs-uid",
  replicas: { desired: 2, current: 2, ready: 2, available: 2 },
  revision: null,
  currentRevision: null,
  ownerReferences: [
    {
      api_version: "apps/v1",
      kind: "Deployment",
      name: "cart",
      uid: "dep-uid",
      controller: true,
    },
  ],
} as unknown as ReplicaSetInfo;

const NOT_FOUND = {
  code: "NOT_FOUND",
  message: `Kubernetes API error: ApiError: pods "${NAME}" not found: NotFound`,
};

let gone = false;
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const calls = (command: string) =>
  vi.mocked(invoke).mock.calls.filter(([name]) => name === command).length;
const aboutThePod = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([, args]) => JSON.stringify(args ?? {}).includes(NAME))
    .length;

beforeEach(() => {
  gone = false;
  vi.useFakeTimers();
  useWindowActivity.setState({
    visible: true,
    focused: true,
    interactionAt: 0,
  });
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "get_pod") {
      if (gone) throw NOT_FOUND;
      return POD;
    }
    if (command === "get_replicaset") return REPLICA_SET;
    return undefined;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(invoke).mockImplementation(async () => undefined);
  useClusterStore.setState({ currentContext: null, isConnected: false });
});

describe("a pod page whose pod is deleted while it is open", () => {
  /**
   * The page held its last read over the 404 as if a poll had dropped, and
   * read "Running, 1 of 1 ready" with live Restart and Delete a minute after
   * the pod was gone, beside a peek that already said so.
   */
  it("says what the peek says, with the owner, and stops reading the pod", async () => {
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    expect(screen.queryByText("This Pod no longer exists.")).toBeNull();

    gone = true;
    await advance(REFRESH_INTERVALS.resourceDetail);
    await advance(0);

    expect(screen.getByText("This Pod no longer exists.")).toBeInTheDocument();
    expect(screen.getByText(/owned it through ReplicaSet/)).toHaveTextContent(
      /^Deployment (Deployment )?cart owned it through ReplicaSet (ReplicaSet )?cart-9df89489c, which replaces what it loses/
    );
    expect(screen.queryByRole("button", { name: /Restart/ })).toBeNull();

    const reads = calls("get_pod");
    const asked = aboutThePod();
    await advance(60_000);
    expect(calls("get_pod")).toBe(reads);
    expect(aboutThePod()).toBe(asked);
  });
});
