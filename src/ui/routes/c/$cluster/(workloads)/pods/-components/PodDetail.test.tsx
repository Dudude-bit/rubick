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

import type { EventInfo, PodInfo, ReplicaSetInfo } from "@/generated/types";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithRouter } from "@/test/render";
import { marcoReview } from "@/test/marco";
import type { AccessQuery } from "@/generated/types";
import { PodDetail } from "./PodDetail";

vi.mock("@/components/terminal/Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="terminal-stub" data-session-id={sessionId ?? ""} />
  ),
}));

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
  vi.mocked(invoke).mockImplementation(async (command: string, args) => {
    if (command === "get_pod") {
      if (gone) throw NOT_FOUND;
      return POD;
    }
    if (command === "get_replicaset") return REPLICA_SET;
    if (command === "open_pod_shell") return "term-1";
    if (command === "check_access")
      return (args as { queries: AccessQuery[] }).queries.map((query) => ({
        ...query,
        allowed: true,
      }));
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

  /**
   * Dana had a shell open on the pod when it was deleted: the page turned
   * into "This Pod no longer exists" and the terminal vanished with no word.
   * Fails if the gone page does not say the session ended with the pod.
   */
  it("says the open shell ended because the pod is gone", async () => {
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}?shell=app`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    expect(screen.queryByText(/shell session ended/)).toBeNull();

    gone = true;
    await advance(REFRESH_INTERVALS.resourceDetail);
    await advance(0);

    expect(screen.getByText("This Pod no longer exists.")).toBeInTheDocument();
    expect(
      screen.getByText(/shell session ended: its pod was deleted/)
    ).toBeInTheDocument();
  });

  /** Fails if the note claims a session on a page that never opened one. */
  it("says nothing about a shell nobody opened", async () => {
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    gone = true;
    await advance(REFRESH_INTERVALS.resourceDetail);
    await advance(0);
    expect(screen.getByText("This Pod no longer exists.")).toBeInTheDocument();
    expect(screen.queryByText(/shell session ended/)).toBeNull();
  });
});

describe("Marco's pod page, in a namespace where he may exec and forward but not debug", () => {
  /**
   * Marco's checkout-api page offered a live Debug whose Start the cluster
   * refuses: can-i patch pods/ephemeralcontainers and can-i create pods both
   * say no. Fails if Debug is runnable there, or if Port forward and Delete,
   * which his Role allows, are greyed with it.
   */
  it("greys Debug with both can-i questions and leaves what he may do offered", async () => {
    useClusterStore.setState((s) => ({
      currentContext: "acme-staging",
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    vi.mocked(invoke).mockImplementation(async (command: string, args) => {
      if (command === "get_pod") return { ...POD, namespace: "team-checkout" };
      if (command === "check_access")
        return marcoReview((args as { queries: AccessQuery[] }).queries);
      return undefined;
    });
    await renderWithRouter(<PodDetail />, {
      at: `/c/acme-staging/pods/team-checkout/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);

    const debug = screen.getByRole("button", { name: "Debug" });
    expect(debug).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      debug.focus();
    });
    await advance(300);
    expect(
      screen.getAllByText(
        /can-i patch pods\/ephemeralcontainers -n team-checkout and to kubectl auth can-i create pods -n team-checkout/
      ).length
    ).toBeGreaterThan(0);
    act(() => debug.click());
    expect(screen.queryByText("Debug Mode")).toBeNull();

    for (const offered of ["Port forward", "Delete"])
      expect(screen.getByRole("button", { name: offered })).not.toHaveAttribute(
        "aria-disabled"
      );
  });
});

const podEvent = (
  reason: string,
  type: "Normal" | "Warning",
  count: number
): EventInfo => ({
  name: `${NAME}.${reason}`,
  namespace: "shop",
  uid: `event-${reason}`,
  type,
  reason,
  message: `${reason} message`,
  source: "kubelet",
  involvedObject: {
    kind: "Pod",
    name: NAME,
    namespace: "shop",
    uid: "pod-uid",
  },
  count,
  firstTimestamp: "2026-10-07T06:00:00Z",
  lastTimestamp: "2026-10-07T06:30:00Z",
});

const KUBECTL_EVENTS = [
  podEvent("BackOff", "Warning", 29),
  podEvent("Pulled", "Normal", 11),
  podEvent("Created", "Normal", 11),
  podEvent("Started", "Normal", 11),
  podEvent("Scheduled", "Normal", 1),
];

async function openEvents(events: () => Promise<EventInfo[]>) {
  vi.mocked(invoke).mockImplementation(async (command: string, args) => {
    if (command === "get_pod") return POD;
    if (command === "get_replicaset") return REPLICA_SET;
    if (command === "list_events") return events();
    if (command === "check_access")
      return (args as { queries: AccessQuery[] }).queries.map((query) => ({
        ...query,
        allowed: true,
      }));
    return undefined;
  });
  await renderWithRouter(<PodDetail />, {
    at: `/c/prod/pods/shop/${NAME}?tab=events`,
    route: "/c/$cluster/pods/$namespace/$name",
  });
  await advance(0);
  await advance(0);
}

describe("the pod page's Events", () => {
  /**
   * Sam found no Events on checkout-55cbfdc66-bp2q6 while kubectl had five
   * (BackOff x29), though the peek and every other page with events show
   * them. Fails if the pod page has no Events tab or lists fewer than read.
   */
  it("lists the five events kubectl has for the pod, BackOff first", async () => {
    await openEvents(async () => KUBECTL_EVENTS);

    expect(screen.getByRole("tab", { name: /^Events/ })).toHaveAttribute(
      "title",
      "Events: 5"
    );
    for (const reason of ["BackOff", "Pulled", "Created", "Started"])
      expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
  });

  /**
   * A refused read drew as "No events for this object" on the pages that
   * swallowed it. Fails if the tab or its mark reads a 403 as none.
   */
  it("says it could not read the events where the cluster refused, and marks the tab unchecked", async () => {
    await openEvents(async () => {
      throw {
        code: "KUBE_API_ERROR",
        message: 'events is forbidden: User "marco" cannot list events',
      };
    });

    expect(
      screen.getAllByText("Could not read events.").length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("No events for this object")).toBeNull();
    expect(
      screen.getByRole("tab", { name: "Events: Could not read events." })
    ).toBeInTheDocument();
  });
});
