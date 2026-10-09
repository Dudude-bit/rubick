import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, fireEvent, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { EventInfo, PodInfo, ReplicaSetInfo } from "@/generated/types";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithRouter } from "@/test/render";
import { marcoReview } from "@/test/marco";
import type { AccessQuery } from "@/generated/types";
import { useShellAskStore } from "@/stores/shellAskStore";
import { PodDetail } from "./PodDetail";

vi.mock("@/components/terminal/Terminal", async () => {
  const { useEffect } = await import("react");
  return {
    Terminal: ({
      sessionId,
      onSize,
    }: {
      sessionId?: string;
      onSize?: (cols: number, rows: number) => void;
    }) => {
      useEffect(() => onSize?.(120, 40), [onSize]);
      return (
        <div data-testid="terminal-stub" data-session-id={sessionId ?? ""} />
      );
    },
  };
});

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
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^Shell/ }));
    await advance(0);
    expect(screen.queryByText(/shell session ended/)).toBeNull();

    gone = true;
    for (let read = 0; read < 2; read++) {
      await advance(REFRESH_INTERVALS.resourceDetail);
      await advance(0);
    }

    expect(screen.getByText("This Pod no longer exists.")).toBeInTheDocument();
    expect(
      screen.getByText(/shell session ended: its pod was deleted/)
    ).toBeInTheDocument();
  });

  /** Fails if the note claims a session on a page that never opened one, landing on Shell included. */
  it("says nothing about a shell nobody opened", async () => {
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}?tab=shell`,
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

describe("a crash-looping pod caught while its container is up", () => {
  /**
   * Sam's checkout pod read green Running and no trouble on its Logs tab
   * while its Overview said CrashLoopBackOff a moment before. Fails if the
   * header drops the loop at the running instant, or paints it green.
   */
  it("keeps the crash loop in the header and the badge red", async () => {
    const finishedAt = new Date(Date.now() - 30_000).toISOString();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod")
        return {
          ...POD,
          status: { ...POD.status, loopingExitAt: finishedAt },
          containers: [
            {
              name: "app",
              image: "busybox:1.36",
              ready: true,
              started: true,
              phase: "app",
              state: { type: "running" },
              lastTerminated: {
                exitCode: 1,
                signal: null,
                reason: "Error",
                message: null,
                startedAt: null,
                finishedAt,
              },
              restartCount: 6,
              ports: [],
              resources: { requests: {}, limits: {} },
              env: [],
              envFrom: [],
            },
          ],
        };
      if (command === "get_replicaset") return REPLICA_SET;
      return undefined;
    });
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);

    expect(
      screen.getAllByText("app starts and then exits, over and over").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Running").className).toContain("text-err");
  });
});

describe("a pod that restarted while the kubelet reports no last exit", () => {
  const UNREPORTED = {
    ...POD,
    restartCount: 15,
    status: { ...POD.status, exitUnreported: true },
    containers: [
      {
        name: "app",
        image: "busybox:1.36",
        ready: true,
        started: true,
        phase: "app",
        state: { type: "running" },
        lastTerminated: null,
        restartCount: 15,
        ports: [],
        resources: { requests: {}, limits: {} },
        env: [],
        envFrom: [],
      },
    ],
  };
  const open = async (events: EventInfo[]) => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod") return UNREPORTED;
      if (command === "get_replicaset") return REPLICA_SET;
      if (command === "list_events") return events;
      return undefined;
    });
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);
  };

  /**
   * Sam's checkout pod, fifteen restarts and no lastState, read green
   * Running with no banner. Fails if the header is green or the page says
   * nothing about the restarts and the exit nobody reported.
   */
  it("is amber and says the last exit is not reported", async () => {
    await open([]);
    expect(screen.getByText("Running").className).toContain("text-warn");
    expect(
      screen.getAllByText("app restarted, and its last exit is not reported")
        .length
    ).toBeGreaterThan(0);
  });

  /**
   * The kubelet backed off the same container a minute before. Fails if
   * the page lets the missing exit turn a loop it can still see into
   * anything else.
   */
  it("keeps the loop while the kubelet is still backing the container off", async () => {
    await open([
      {
        ...podEvent("BackOff", "Warning", 31),
        message: `Back-off restarting failed container app in pod ${NAME}_shop`,
        lastTimestamp: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    expect(screen.getByText("Running").className).toContain("text-err");
    expect(
      screen.getAllByText("app starts and then exits, over and over").length
    ).toBeGreaterThan(0);
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

describe("a pod page whose pod changes between its polls", () => {
  afterEach(() => {
    vi.mocked(listen).mockImplementation(async () => () => {});
  });

  /**
   * Sam's page read CrashLoopBackOff two seconds after kubectl said Running,
   * while the Pods list had already moved: no list's watch runs under a page.
   * Fails if the page waits for its next poll instead of reading the pod
   * when the pod's own watch sees it change.
   */
  it("reads the pod again when its watch sees it change, before its next poll", async () => {
    let dispatch: ((event: { payload: unknown }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "resource-event") dispatch = handler as typeof dispatch;
      return () => {};
    });
    const answer = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "subscribe_object_watch"
        ? "pod-stream"
        : answer(command, args)
    );

    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    expect(invoke).toHaveBeenCalledWith("subscribe_object_watch", {
      kind: "Pod",
      namespace: "shop",
      name: NAME,
    });
    const reads = calls("get_pod");

    dispatch!({
      payload: {
        stream_id: "pod-stream",
        changes: [{ op: "applied", resource: POD }],
        error: null,
      },
    });
    await advance(300);

    expect(calls("get_pod")).toBe(reads + 1);
  });
});

const APP_CONTAINER = {
  name: "app",
  image: "busybox:1.36",
  ready: true,
  started: true,
  phase: "app",
  state: { type: "running" },
  lastTerminated: null,
  restartCount: 0,
  ports: [],
  resources: { requests: {}, limits: {} },
  env: [],
  envFrom: [],
};

const running = (name: string) =>
  ({
    ...POD,
    name,
    uid: `uid-${name}`,
    containers: [APP_CONTAINER],
  }) as unknown as PodInfo;

const POD_ROUTE = "/c/$cluster/pods/$namespace/$name";

const execCommands = [
  "open_pod_shell",
  "list_container_files",
  "container_working_dir",
  "read_container_file",
  "run_pod_check",
];
const execs = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => execCommands.includes(command))
    .map(
      ([command, args]) =>
        `${command} ${(args as { pod?: string; name?: string }).pod ?? (args as { name?: string }).name}`
    );

async function arrive(at: string) {
  const rendered = await renderWithRouter(<PodDetail />, {
    at,
    route: POD_ROUTE,
    beside: { "/c/$cluster/events": <p>events page</p> },
  });
  await advance(0);
  await advance(0);
  return rendered;
}

const clickTab = async (name: RegExp) => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
  await advance(0);
  await advance(0);
};

describe("a pod page runs nothing in the container until the reader asks on it", () => {
  beforeEach(() => {
    useShellAskStore.getState().drop();
    vi.mocked(invoke).mockImplementation(async (command: string, args) => {
      if (command === "get_pod")
        return running((args as { name: string }).name);
      if (command === "open_pod_shell") return "term-1";
      if (command === "check_access")
        return (args as { queries: AccessQuery[] }).queries.map((query) => ({
          ...query,
          allowed: true,
        }));
      return undefined;
    });
  });

  /**
   * Dana opened cart-4f68h by link from a pod page where she had used Shell:
   * the same page, moved to the next pod, opened a shell in it within seconds
   * while she was on Overview. Fails if the move starts anything.
   */
  it("does not open a shell on the next pod when the page is moved there by a link", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    await clickTab(/^Shell/);
    expect(execs()).toEqual(["open_pod_shell cart-a"]);

    await act(() => router.navigate({ href: "/c/prod/pods/shop/cart-b" }));
    await advance(0);
    await advance(0);

    expect(execs()).toEqual(["open_pod_shell cart-a"]);
    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });
  });

  /**
   * The same move with Shell still the open tab: what was asked on one pod
   * is not asked on the next. Fails if the ask follows the page.
   */
  it("offers a shell rather than opening one when the page moves to the next pod on Shell", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    await clickTab(/^Shell/);

    await act(() =>
      router.navigate({ href: "/c/prod/pods/shop/cart-b?tab=shell" })
    );
    await advance(0);
    await advance(0);

    expect(execs()).toEqual(["open_pod_shell cart-a"]);
    expect(
      screen.getByRole("button", { name: "Start a shell in app" })
    ).toBeInTheDocument();
  });

  /**
   * A link, a restored tab or Back can land on Shell. Nobody asked; the tab
   * offers. Fails if arriving on the tab opens the exec.
   */
  it.each([
    ["a restored tab on Shell", "?tab=shell"],
    ["an address that names a container", "?shell=app"],
  ])(
    "lands on %s without starting a shell, and starts on the button",
    async (_, search) => {
      await arrive(`/c/prod/pods/shop/cart-a${search}`);
      expect(execs()).toEqual([]);

      fireEvent.click(
        screen.getByRole("button", { name: "Start a shell in app" })
      );
      await advance(0);
      await advance(0);
      expect(execs()).toEqual(["open_pod_shell cart-a"]);
    }
  );

  /** Files lists by exec; a link may name the tab. Fails if arriving lists. */
  it("lands on Files without reading a folder, and reads on the button", async () => {
    await arrive("/c/prod/pods/shop/cart-a?tab=files");
    expect(execs()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Read the files" }));
    await advance(0);
    await advance(0);
    expect(execs()).toContain("container_working_dir cart-a");
  });

  /** Fails if Checks starts probing on arrival rather than on Run. */
  it("lands on Checks without running a check", async () => {
    await arrive("/c/prod/pods/shop/cart-a?tab=checks");
    expect(execs()).toEqual([]);
  });

  /**
   * Shell in the peek is the reader asking, so the page opens on a live shell;
   * the ask is spent, so Back to the same address does not open another.
   */
  it("opens the shell the peek asked for, once", async () => {
    useShellAskStore.getState().askFor("shop", "cart-a");
    const { unmount } = await arrive("/c/prod/pods/shop/cart-a?shell=app");
    expect(execs()).toEqual(["open_pod_shell cart-a"]);
    unmount();

    await arrive("/c/prod/pods/shop/cart-a?shell=app");
    expect(execs()).toEqual(["open_pod_shell cart-a"]);
  });

  /** Fails if leaving the page leaves the session open behind it. */
  it("closes the session when the page goes away", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    await clickTab(/^Shell/);
    await act(() => router.navigate({ href: "/c/prod/events" }));
    await advance(0);

    expect(screen.getByText("events page")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });
  });
});
