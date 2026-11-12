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
import { terminationAt } from "@/lib/pod-status";
import { useClusterStore } from "@/stores/clusterStore";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithRouter } from "@/test/render";
import { marcoReview } from "@/test/marco";
import type { AccessQuery } from "@/generated/types";
import { useShellAskStore } from "@/stores/shellAskStore";
import { useKeptShellStore, type KeptShell } from "@/stores/keptShellStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { keepShells } from "@/hooks/useKeptShells";
import type { AnyRouter } from "@tanstack/react-router";
import { parseDeepLink } from "@/lib/deep-link";
import { Toaster } from "@/components/ui/toaster";
import { PodDetail } from "./PodDetail";

vi.mock("@/components/terminal/Terminal", async () => {
  const { useEffect } = await import("react");
  return {
    Terminal: ({
      sessionId,
      onSize,
      onClose,
    }: {
      sessionId?: string;
      onSize?: (cols: number, rows: number) => void;
      onClose?: () => void;
    }) => {
      useEffect(() => onSize?.(120, 40), [onSize]);
      return (
        <div data-testid="terminal-stub" data-session-id={sessionId ?? ""}>
          <button type="button" aria-label="end the shell" onClick={onClose} />
        </div>
      );
    },
  };
});

const NAME = "cart-9df89489c-n6rzf";

const RUNNING = {
  name: "cart",
  image: "cart:1.4",
  ready: true,
  started: true,
  phase: "app",
  state: { type: "running" },
  lastTerminated: null,
  restartCount: 0,
  ports: [],
  env: [],
  resources: { requests: {}, limits: {} },
  envFrom: [],
};

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
  useKeptShellStore.setState({ shells: [] });
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
    const answer = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "get_pod" && !gone
        ? { ...POD, containers: [RUNNING] }
        : answer(command, args)
    );
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /^Shell/ }));
    await advance(0);
    expect(screen.queryByText(/shell ended/)).toBeNull();

    gone = true;
    for (let read = 0; read < 2; read++) {
      await advance(REFRESH_INTERVALS.resourceDetail);
      await advance(0);
    }

    expect(screen.getByText("This Pod no longer exists.")).toBeInTheDocument();
    expect(
      screen.getByText(/shell ended: its pod was deleted/)
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
    expect(screen.queryByText(/shell ended/)).toBeNull();
  });
});

describe("Marco's pod page, in a namespace where he may exec and forward but not debug", () => {
  /**
   * Marco's checkout-api page offered a live Debug whose Start the cluster
   * refuses: can-i patch pods --subresource=ephemeralcontainers and can-i create pods both
   * say no. Fails if Debug is runnable there, or if Port forward and Delete,
   * which his Role allows, are greyed with it.
   */
  it("greys Debug with both can-i questions and leaves what he may do offered", async () => {
    useClusterStore.setState((s) => ({
      currentContext: "acme-staging",
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    vi.mocked(invoke).mockImplementation(async (command: string, args) => {
      if (command === "get_pod")
        return { ...POD, namespace: "team-checkout", containers: [RUNNING] };
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
        /can-i patch pods\/cart-9df89489c-n6rzf --subresource=ephemeralcontainers -n team-checkout and to kubectl auth can-i create pods -n team-checkout/
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

describe("Port forward on a pod with no container running", () => {
  /**
   * Marco's checkout-worker, stuck in CreateContainerConfigError: its Shell
   * tab said nothing runs while its Port forward opened a dialog as if
   * something could answer. Fails if the page offers what the peek refuses.
   */
  it("greys Port forward with the peek's own reason", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_pod"
        ? {
            ...POD,
            status: {
              ...POD.status,
              phase: "Pending",
              display: "CreateContainerConfigError",
              ready: false,
            },
            containers: [
              {
                ...RUNNING,
                ready: false,
                started: false,
                state: {
                  type: "waiting",
                  reason: "CreateContainerConfigError",
                },
              },
            ],
          }
        : undefined
    );
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);

    const forward = screen.getByRole("button", { name: "Port forward" });
    expect(forward).toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      forward.focus();
    });
    await advance(300);
    expect(
      screen.getAllByText(/^Nothing is listening yet: no container is running/)
        .length
    ).toBeGreaterThan(0);
    act(() => forward.click());
    expect(screen.queryByText("Port in the pod")).toBeNull();
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
          status: {
            ...POD.status,
            loopingUntil: new Date(Date.now() + 60_000).toISOString(),
          },
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

  /**
   * Sam's checkout page said "app starts and then exits, over and over" up
   * and backing off, and "app exited with 1" the instant a run ended: one
   * loop told two ways. Fails if the exit that just ended a run of the loop
   * drops the loop framing, or stops naming that exit beneath it.
   */
  it("keeps the loop framing the instant a run ends, with that exit as its detail", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod")
        return {
          ...POD,
          status: { ...POD.status, display: "Error", loopingUntil: until },
          containers: [
            {
              name: "app",
              image: "busybox:1.36",
              ready: false,
              started: false,
              phase: "app",
              state: {
                type: "terminated",
                termination: {
                  exitCode: 1,
                  signal: null,
                  reason: "Error",
                  message: null,
                  startedAt: new Date(Date.now() - 6_000).toISOString(),
                  finishedAt: new Date(Date.now() - 2_000).toISOString(),
                },
              },
              lastTerminated: null,
              restartCount: 57,
              loopingUntil: until,
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
    expect(screen.queryByText("app exited with 1")).toBeNull();
    expect(
      screen.getAllByText(/the last run ended Error · exit 1/).length
    ).toBeGreaterThan(0);
  });
});

describe("the cause a crash-looping pod's page leads with", () => {
  /**
   * The owner's question on every red page is why. Fails if the headline
   * stops leading with the exit and its meaning, or the run's own last line
   * read from the node does not follow it.
   */
  it("leads with the exit, what it means and the run's last line", async () => {
    const ended = new Date(Date.now() - 20_000).toISOString();
    const started = new Date(Date.now() - 23_000).toISOString();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod")
        return {
          ...POD,
          status: {
            ...POD.status,
            display: "CrashLoopBackOff",
            cause: {
              says: "exits",
              container: "app",
              restarts: 7,
              until: null,
              run: {
                code: 127,
                signal: null,
                reason: "Error",
                started,
                ended,
                previous: true,
                said: null,
                log: { says: "notRead" },
                limit: null,
              },
            },
          },
          containers: [
            {
              name: "app",
              image: "busybox:1.36",
              ready: false,
              started: false,
              phase: "app",
              state: {
                type: "waiting",
                reason: "CrashLoopBackOff",
                message: null,
              },
              lastTerminated: {
                exitCode: 127,
                signal: null,
                reason: "Error",
                message: null,
                startedAt: started,
                finishedAt: ended,
              },
              restartCount: 7,
              ports: [],
              resources: { requests: {}, limits: {} },
              env: [],
              envFrom: [],
            },
          ],
        };
      if (command === "get_pod_logs")
        return [
          {
            raw: "sh: /app/server: not found",
            message: "sh: /app/server: not found",
          },
        ];
      if (command === "get_replicaset") return REPLICA_SET;
      return undefined;
    });
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);
    await advance(0);

    expect(
      screen.getAllByText(
        "app exited (exit 127, Error): its command was not found in the image, after running 3s"
      ).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("sh: /app/server: not found").length
    ).toBeGreaterThan(0);
  });
});

describe("the log a crash-looping pod's headline points at", () => {
  /**
   * The headline said what the container printed before it died was in
   * Logs, the promise Dana's init-demo showed the node had broken. Fails if
   * the headline promises the log without the node's answer.
   */
  it("says the node no longer has the run's log when the node says so", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod")
        return {
          ...POD,
          status: { ...POD.status, display: "CrashLoopBackOff" },
          containers: [
            {
              name: "app",
              image: "busybox:1.36",
              ready: false,
              started: false,
              phase: "app",
              state: { type: "waiting", reason: "CrashLoopBackOff" },
              lastTerminated: {
                exitCode: 1,
                signal: null,
                reason: "Error",
                message: null,
                startedAt: null,
                finishedAt: new Date(Date.now() - 30_000).toISOString(),
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
      if (command === "get_pod_logs")
        throw { code: "LOG_NOT_KEPT", message: "unable to retrieve" };
      return undefined;
    });
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    for (let tick = 0; tick < 6; tick++) await advance(10);

    expect(
      screen.getAllByText(/The node no longer has that run's log\./).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/before it died is in Logs/)).toBeNull();
    expect(screen.queryByText(/printed is in Logs/)).toBeNull();
  });
});

describe("the age of a crash-looping pod's last exit", () => {
  /**
   * Sam's checkout page said "the last run ended Error · exit 1, 2s ago" for
   * minutes while the Restarts row beside it ticked to "last 1m ago": the
   * age was formatted once, when the pod was read. Fails if the headline's
   * age, or the Containers tab's, stops moving with the clock between reads.
   */
  it("moves with the clock on the headline and the Containers tab alike", async () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    const exit = {
      exitCode: 1,
      signal: null,
      reason: "Error",
      message: null,
      startedAt: new Date(Date.now() - 6_000).toISOString(),
      finishedAt: new Date(Date.now() - 2_000).toISOString(),
    };
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod")
        return {
          ...POD,
          restartCount: 72,
          lastRestartAt: exit.finishedAt,
          status: { ...POD.status, display: "Error", loopingUntil: until },
          containers: [
            {
              name: "app",
              image: "busybox:1.36",
              ready: false,
              started: false,
              phase: "app",
              state: { type: "terminated", termination: exit },
              lastTerminated: null,
              restartCount: 72,
              loopingUntil: until,
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
      at: `/c/prod/pods/shop/${NAME}?tab=containers`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);
    const ages = () =>
      screen
        .getAllByTitle(terminationAt(exit) ?? "")
        .map((age) => age.textContent);
    expect(ages()).toEqual(["2s ago", "2s ago", "2s ago"]);

    await advance(70_000);

    expect(ages()).toEqual(["1m ago", "1m ago", "1m ago"]);
  });
});

describe("a pod the scheduler has not placed yet", () => {
  const SAID =
    "0/2 nodes are available: 2 node(s) didn't match Pod's node affinity/selector.";

  /**
   * Sam's never-placed pod, 45 s into its 60 s wait, had a blue Pending
   * badge beside a red Unschedulable and a red "No node will take this pod",
   * over amber "unscheduled" and "0 of 1 ready". Fails if anything on the
   * page calls the wait a fault before the badge does, or still calls it
   * waiting once the wait has run out.
   */
  it("reads as waiting in blue inside the wait, and as a fault once it runs out", async () => {
    const until = new Date(Date.now() + 15_000).toISOString();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod")
        return {
          ...POD,
          nodeName: null,
          podIp: null,
          hostIp: null,
          status: {
            phase: "Pending",
            display: "Pending",
            ready: false,
            conditions: [
              {
                type: "PodScheduled",
                status: "False",
                reason: "Unschedulable",
                message: SAID,
                lastTransitionTime: null,
              },
            ],
            message: null,
            reason: null,
          },
          containers: [
            {
              name: "app",
              image: "busybox:1.36",
              ready: false,
              started: false,
              phase: "app",
              state: { type: "waiting", reason: null },
              lastTerminated: null,
              restartCount: 0,
              ports: [],
              resources: { requests: {}, limits: {} },
              env: [],
              envFrom: [],
            },
          ],
          start: { state: "starting", until },
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

    const tone = (text: string) => screen.getAllByText(text)[0].className;
    expect(tone("Waiting to be placed on a node")).toContain("text-info");
    expect(screen.queryByText("No node will take this pod")).toBeNull();
    expect(tone("Unschedulable")).toContain("text-info");
    expect(tone("unscheduled")).toContain("text-info");
    expect(tone("0 of 1 ready")).toContain("text-info");
    expect(
      screen.getAllByText((_, node) => node?.textContent === SAID).length
    ).toBeGreaterThan(0);
    const conditions = () => screen.getByRole("tab", { name: /^Conditions/ });
    expect(conditions()).toHaveAccessibleName(
      "Conditions: Waiting to be placed on a node"
    );
    expect(conditions().querySelector(".bg-info")).not.toBeNull();

    await advance(20_000);

    expect(tone("No node will take this pod")).toContain("text-err");
    expect(screen.queryByText("Waiting to be placed on a node")).toBeNull();
    expect(tone("Unschedulable")).toContain("text-err");
    expect(tone("unscheduled")).toContain("text-warn");
    expect(tone("0 of 1 ready")).toContain("text-warn");
    expect(conditions().querySelector(".bg-warn")).not.toBeNull();
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

describe("a pod the node evicted while an init container ran", () => {
  const exit = {
    exitCode: 137,
    signal: null,
    reason: "ContainerStatusUnknown",
    message: null,
    startedAt: "2026-10-12T00:00:00Z",
    finishedAt: "2026-10-12T00:01:00Z",
  };
  const EVICTED = {
    ...POD,
    status: {
      ...POD.status,
      phase: "Failed",
      display: "Evicted",
      kubectlStatus: "Init:ContainerStatusUnknown",
      failedAt: new Date(Date.now() - 13 * 3_600_000).toISOString(),
      ready: false,
      reason: "Evicted",
      message: "The node was low on resource: ephemeral-storage.",
    },
    initContainers: [
      {
        name: "migrate",
        image: "busybox:1.36",
        ready: false,
        started: false,
        phase: "init",
        state: { type: "terminated", termination: exit },
        lastTerminated: exit,
        restartCount: 7,
        ports: [],
        resources: { requests: {}, limits: {} },
        env: [],
        envFrom: [],
      },
    ],
  };

  /**
   * Dana's init-demo headline blamed migrate's exit 137 and never said
   * Evicted, while the Overview said Evicted with the node's message. Fails
   * if a container's exit leads over the verdict on the whole pod.
   */
  it("leads with the eviction and the node's words, not the container's exit", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod") return EVICTED;
      if (command === "get_replicaset") return REPLICA_SET;
      if (command === "list_events") return [];
      return undefined;
    });
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);
    expect(screen.getAllByText("Evicted").length).toBeGreaterThan(0);
    expect(document.body).toHaveTextContent(
      "The node was low on resource: ephemeral-storage."
    );
    expect(screen.queryByText("migrate exited with 137")).toBeNull();
  });

  /**
   * payments' evicted pod led with the node's words and nothing else, while
   * the Overview said "already replaced" and its ReplicaSet had long since
   * started another. Fails if the header or the summary stops saying so and
   * naming the controller, or says it of an evicted pod nothing replaced.
   */
  it("says its controller already replaced it, in the header and under the eviction", async () => {
    let pod: unknown = {
      ...EVICTED,
      status: { ...EVICTED.status, gone: "replaced" },
    };
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod") return pod;
      if (command === "get_replicaset") return REPLICA_SET;
      if (command === "list_events") return [];
      return undefined;
    });
    const { unmount } = await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);
    expect(screen.getByText("already replaced")).toBeInTheDocument();
    expect(screen.getByTestId("replaced-note")).toHaveTextContent(
      /^Already replaced: ReplicaSet cart-9df89489c started another pod in its place/
    );
    unmount();
    pod = EVICTED;
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);
    expect(screen.getAllByText("Evicted").length).toBeGreaterThan(0);
    expect(screen.queryByText("already replaced")).toBeNull();
    expect(screen.queryByTestId("replaced-note")).toBeNull();
  });

  /**
   * Marco's header read "Evicted 3d old" for an eviction thirteen hours
   * before: the age beside the word was the pod's. Fails if the header stops
   * dating the failure, or drops the pod's age to do it.
   */
  it("dates the eviction beside its word and keeps the pod's age apart", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "get_pod") return EVICTED;
      if (command === "get_replicaset") return REPLICA_SET;
      if (command === "list_events") return [];
      return undefined;
    });
    await renderWithRouter(<PodDetail />, {
      at: `/c/prod/pods/shop/${NAME}`,
      route: "/c/$cluster/pods/$namespace/$name",
    });
    await advance(0);
    await advance(0);
    expect(screen.getByTestId("ended-ago")).toHaveTextContent("ended 13h ago");
    expect(document.body).toHaveTextContent(/\dd old/);
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

async function arrive(at: string, page = <PodDetail />) {
  const rendered = await renderWithRouter(page, {
    at,
    route: POD_ROUTE,
    beside: { "/c/$cluster/events": <p>events page</p> },
  });
  await advance(0);
  await advance(0);
  return rendered;
}

/** The window's keeper of shells, as App runs it, and what it said on the way. */
let stopKeeping: (() => void) | null = null;
const leftPage: KeptShell[] = [];
function keepingShells(router: AnyRouter) {
  stopKeeping = keepShells(
    router,
    (shell) => leftPage.push(shell),
    () => {}
  );
}

const terminal = () => screen.queryByTestId("terminal-stub");

/** Shell in the peek, or a row's menu, on the pod as it was read there. */
const peekAsk = (pod: string, uid = `uid-${pod}`) => ({
  namespace: "shop",
  pod,
  uid,
  container: "app",
});

/** The containers shells were opened in, in order. */
const shellsIn = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "open_pod_shell")
    .map(([, args]) => (args as { container: string }).container);

const CRASHED = {
  ...APP_CONTAINER,
  ready: false,
  state: { type: "waiting", reason: "CrashLoopBackOff", message: null },
};

/** The pod the page reads, as the test last set it, and the backend's events. */
let served: PodInfo | null = null;
const heardBy = new Map<string, Set<(event: { payload: unknown }) => void>>();
const emit = (event: string, payload: unknown) =>
  act(() => heardBy.get(event)?.forEach((handler) => handler({ payload })));
/** Long enough for a page that has backed off to read the pod again. */
const nextRead = async () => {
  for (let poll = 0; poll < 30; poll++)
    await advance(REFRESH_INTERVALS.resourceDetail);
  await advance(0);
};

const clickTab = async (name: RegExp) => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
  await advance(0);
  await advance(0);
};

describe("a pod page runs nothing in the container until the reader asks on it", () => {
  afterEach(() => {
    stopKeeping?.();
    stopKeeping = null;
    leftPage.length = 0;
    vi.mocked(listen).mockImplementation(async () => () => {});
  });

  beforeEach(() => {
    useShellAskStore.getState().drop();
    useKeptShellStore.setState({ shells: [] });
    useScopeTabStore.setState({
      tabs: [
        {
          id: "tab-1",
          context: "prod",
          namespace: "",
          scope: [],
          href: "/c/prod",
          missing: false,
        },
      ],
      activeId: "tab-1",
      pendingHref: null,
    });
    served = null;
    heardBy.clear();
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      const handlers = heardBy.get(event) ?? new Set();
      heardBy.set(event, handlers.add(handler as never));
      return () => handlers.delete(handler as never);
    });
    let opened = 0;
    vi.mocked(invoke).mockImplementation(async (command: string, args) => {
      if (command === "get_pod")
        return served ?? running((args as { name: string }).name);
      if (command === "open_pod_shell") return `term-${++opened}`;
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
    keepingShells(router);
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
   * offers, and says a click on it is the ask, which is what Dana saw it do.
   * Fails if arriving on the tab opens the exec, or if the offer says a shell
   * waits for some other ask.
   */
  it.each([
    ["a restored tab on Shell", "?tab=shell"],
    ["an address that names a container", "?shell=app"],
  ])(
    "lands on %s without starting a shell, and starts on the button",
    async (_, search) => {
      await arrive(`/c/prod/pods/shop/cart-a${search}`);
      expect(execs()).toEqual([]);
      expect(
        screen.getByText(/only a click starts one: on the Shell tab/)
      ).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Start a shell in app" })
      );
      await advance(0);
      await advance(0);
      expect(execs()).toEqual(["open_pod_shell cart-a"]);
    }
  );

  /**
   * Dana landed on Shell by Back and clicked the Shell tab twice: the offer
   * says a click on the tab starts one, and nothing started. Fails if a click
   * on the tab already open does not ask, as the button does.
   */
  it.each([
    ["Shell", "?tab=shell", "open_pod_shell cart-a"],
    ["Files", "?tab=files", "container_working_dir cart-a"],
  ])(
    "starts on a click on the %s tab it landed on",
    async (tab, search, exec) => {
      await arrive(`/c/prod/pods/shop/cart-a${search}`);
      expect(execs()).toEqual([]);

      fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${tab}`) }));
      await advance(0);
      await advance(0);
      expect(execs()).toContain(exec);
    }
  );

  /**
   * Dana's link with `?tab=shell` landed on Overview while `?tab=logs` landed
   * on Logs. Fails if the link loses its tab on the way in, or if landing on
   * Shell starts anything.
   */
  it("lands a link that names Shell on its offer, and starts nothing", async () => {
    const link = parseDeepLink(
      "rubick://open/c/prod/pods/shop/cart-a?tab=shell&t=2026-10-09T15:00:00Z"
    );
    await arrive(link!.path);
    await advance(10_000);

    expect(screen.getByRole("tab", { name: /^Shell/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen.getByRole("button", { name: "Start a shell in app" })
    ).toBeInTheDocument();
    expect(execs()).toEqual([]);
  });

  /**
   * Dana ended a shell with its x and clicked the Shell tab: nothing started,
   * only the container chip did. Fails if ending restarts on its own, or if a
   * click on the tab, open or not, does not start a new shell.
   */
  it.each([
    ["the Shell tab already open", null],
    ["the Shell tab from another tab", /^Overview/],
  ])(
    "starts a new shell on a click on %s after the last one was ended",
    async (_, away) => {
      let opened = 0;
      vi.mocked(invoke).mockImplementation(async (command: string, args) => {
        if (command === "get_pod")
          return running((args as { name: string }).name);
        if (command === "open_pod_shell") return `term-${++opened}`;
        if (command === "check_access")
          return (args as { queries: AccessQuery[] }).queries.map((query) => ({
            ...query,
            allowed: true,
          }));
        return undefined;
      });
      await arrive("/c/prod/pods/shop/cart-a");
      await clickTab(/^Shell/);
      expect(terminal()).toHaveAttribute("data-session-id", "term-1");

      fireEvent.click(screen.getByRole("button", { name: "end the shell" }));
      await advance(10_000);
      expect(invoke).toHaveBeenCalledWith("close_terminal", {
        sessionId: "term-1",
      });
      expect(terminal()).toBeNull();
      expect(screen.getByText("The shell was ended")).toBeInTheDocument();
      expect(execs()).toEqual(["open_pod_shell cart-a"]);

      if (away) {
        await clickTab(away);
        await clickTab(/^Shell/);
      } else {
        fireEvent.click(screen.getByRole("tab", { name: /^Shell/ }));
        await advance(0);
        await advance(0);
      }

      expect(execs()).toEqual([
        "open_pod_shell cart-a",
        "open_pod_shell cart-a",
      ]);
      expect(terminal()).toHaveAttribute("data-session-id", "term-2");
    }
  );

  /**
   * Files lists by exec; a link may name the tab. Fails if arriving lists, or
   * if the offer does not say a click on the tab is what reads.
   */
  it("lands on Files without reading a folder, and reads on the button", async () => {
    await arrive("/c/prod/pods/shop/cart-a?tab=files");
    expect(execs()).toEqual([]);
    expect(
      screen.getByText(/only a click reads them: on the Files tab/)
    ).toBeInTheDocument();

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
    useShellAskStore.getState().askFor(peekAsk("cart-a"));
    const { unmount } = await arrive("/c/prod/pods/shop/cart-a?shell=app");
    expect(execs()).toEqual(["open_pod_shell cart-a"]);
    unmount();
    useKeptShellStore.setState({ shells: [] });

    await arrive("/c/prod/pods/shop/cart-a?shell=app");
    expect(execs()).toEqual(["open_pod_shell cart-a"]);
  });

  /**
   * Leaving the pod in the same tab ends the shell, and says which. Fails if
   * the session is left open behind the page, or ends without a word.
   */
  it("ends the shell and says so when its tab leaves the pod", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    keepingShells(router);
    await clickTab(/^Shell/);
    expect(leftPage).toEqual([]);

    await act(() => router.navigate({ href: "/c/prod/events" }));
    await advance(0);

    expect(screen.getByText("events page")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });
    expect(leftPage).toMatchObject([{ pod: "cart-a", container: "app" }]);
  });

  /**
   * Dana flipped to another tab to look something up and her shell was gone
   * within 3 s. Fails if parking the tab ends the shell, if coming back opens
   * a second one, or if it lands on Start instead of the shell she had.
   */
  it("keeps the shell while its tab is parked, and comes back to the same one", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    keepingShells(router);
    await clickTab(/^Shell/);
    const owner = useScopeTabStore.getState().activeId;

    await act(async () => {
      useScopeTabStore.setState((state) => ({
        tabs: [...state.tabs, { ...state.tabs[0], id: "other" }],
        activeId: "other",
        pendingHref: "/c/prod/events",
      }));
      await router.navigate({ href: "/c/prod/events" });
    });
    await advance(0);
    act(() => useScopeTabStore.setState({ pendingHref: null }));
    await advance(0);
    expect(screen.getByText("events page")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });
    expect(leftPage).toEqual([]);

    await act(async () => {
      useScopeTabStore.setState({
        activeId: owner,
        pendingHref: "/c/prod/pods/shop/cart-a?tab=shell",
      });
      await router.navigate({ href: "/c/prod/pods/shop/cart-a?tab=shell" });
      useScopeTabStore.setState({ pendingHref: null });
    });
    await advance(0);
    await advance(0);

    expect(execs()).toEqual(["open_pod_shell cart-a"]);
    expect(terminal()).toHaveAttribute("data-session-id", "term-1");
    expect(
      screen.queryByRole("button", { name: "Start a shell in app" })
    ).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });
  });

  /**
   * Picking another container in the chooser ends the shell that is open,
   * as the chooser says. Fails if the old one stays kept and running.
   */
  it("ends the kept shell when the reader picks another container", async () => {
    let opened = 0;
    vi.mocked(invoke).mockImplementation(async (command: string, args) => {
      if (command === "get_pod")
        return {
          ...running((args as { name: string }).name),
          containers: [APP_CONTAINER, { ...APP_CONTAINER, name: "worker" }],
        };
      if (command === "open_pod_shell") return `term-${++opened}`;
      if (command === "check_access")
        return (args as { queries: AccessQuery[] }).queries.map((query) => ({
          ...query,
          allowed: true,
        }));
      return undefined;
    });
    await arrive("/c/prod/pods/shop/cart-a");
    await clickTab(/^Shell/);
    expect(terminal()).toHaveAttribute("data-session-id", "term-1");

    fireEvent.click(screen.getByRole("radio", { name: /worker/ }));
    await advance(0);
    await advance(0);

    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });
    expect(terminal()).toHaveAttribute("data-session-id", "term-2");
    expect(useKeptShellStore.getState().shells).toMatchObject([
      { id: "term-2", container: "worker" },
    ]);
  });

  /** Closing the tab that keeps a shell is its owner leaving. Fails if it stays open. */
  it("ends a parked shell when its tab is closed, without a note", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    keepingShells(router);
    await clickTab(/^Shell/);
    const owner = useScopeTabStore.getState().activeId;
    act(() =>
      useScopeTabStore.setState((state) => ({
        tabs: [...state.tabs, { ...state.tabs[0], id: "other" }],
        activeId: "other",
      }))
    );
    expect(invoke).not.toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });

    act(() =>
      useScopeTabStore.setState((state) => ({
        tabs: state.tabs.filter((tab) => tab.id !== owner),
      }))
    );

    expect(invoke).toHaveBeenCalledWith("close_terminal", {
      sessionId: "term-1",
    });
    expect(useKeptShellStore.getState().shells).toEqual([]);
    expect(leftPage).toEqual([]);
  });

  /**
   * Dana clicked Shell on a crash-looping pod and got a new exec on every
   * cycle, also from the Logs tab: the shell was asked for once and reopened
   * each time the container came back. Fails if a restart opens a shell.
   */
  it("opens no second shell when the container it was asked for comes back", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    keepingShells(router);
    await clickTab(/^Shell/);
    expect(shellsIn()).toEqual(["app"]);

    served = { ...running("cart-a"), containers: [CRASHED] } as PodInfo;
    await nextRead();
    await emit("terminal-closed", { session_id: "term-1" });
    expect(useKeptShellStore.getState().shells).toEqual([]);
    served = {
      ...running("cart-a"),
      containers: [{ ...APP_CONTAINER, restartCount: 1 }],
    } as PodInfo;
    await nextRead();

    expect(shellsIn()).toEqual(["app"]);
    expect(terminal()).toHaveAttribute("data-session-id", "term-1");
  });

  /**
   * The same crash with a sidecar still up: the pane re-keyed to it and
   * opened a prompt in a container nobody chose. Fails if the shell moves.
   */
  it("opens no shell in a sibling when the container it was asked for stops", async () => {
    const worker = { ...APP_CONTAINER, name: "worker", phase: "sidecar" };
    served = {
      ...running("cart-a"),
      containers: [APP_CONTAINER, worker],
    } as PodInfo;
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    keepingShells(router);
    await clickTab(/^Shell/);
    expect(shellsIn()).toEqual(["app"]);

    served = { ...served, containers: [CRASHED, worker] } as PodInfo;
    await nextRead();
    await emit("terminal-closed", { session_id: "term-1" });
    await nextRead();

    expect(shellsIn()).toEqual(["app"]);
    expect(terminal()).toHaveAttribute("data-session-id", "term-1");
  });

  /**
   * A StatefulSet pod comes back under its name as another pod. The ask was
   * for the one that was deleted. Fails if the new pod gets a shell, or its
   * files read, because the old one was asked on this page.
   */
  it.each([
    ["Shell", "open_pod_shell cart-a", "No shell is running here yet"],
    [
      "Files",
      "container_working_dir cart-a",
      "The files have not been read yet",
    ],
  ])(
    "offers %s as never asked, and runs nothing, in a pod re-created under the same name",
    async (tab, exec, offer) => {
      const { router } = await arrive("/c/prod/pods/shop/cart-a");
      keepingShells(router);
      await clickTab(new RegExp(`^${tab}`));
      expect(execs()).toContain(exec);
      const before = execs().length;

      await emit("terminal-closed", { session_id: "term-1" });
      served = { ...running("cart-a"), uid: "uid-recreated" } as PodInfo;
      await nextRead();
      await advance(10_000);

      expect(execs()).toHaveLength(before);
      expect(screen.getByText(offer)).toBeInTheDocument();
    }
  );

  /**
   * The Logs pane stays through a re-creation and has to be told which pod
   * of the name it reads. Fails if the page hands it the new pod and the pane
   * goes on holding the stream of the deleted one.
   */
  it("asks for the log of a pod re-created under the same name", async () => {
    const answer = vi.mocked(invoke).getMockImplementation()!;
    let streams = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "stream_pod_logs" ? `log-${++streams}` : answer(command, args)
    );
    await arrive("/c/prod/pods/shop/cart-a");
    await clickTab(/^Logs/);
    expect(streams).toBe(1);

    served = { ...running("cart-a"), uid: "uid-recreated" } as PodInfo;
    await nextRead();

    expect(streams).toBe(2);
    expect(invoke).toHaveBeenCalledWith("stop_log_stream", {
      streamId: "log-1",
    });
  });

  /**
   * Shell in a peek is an ask about the pod the peek showed. Fails if it
   * opens a shell in a pod re-created under the name before the page read it.
   */
  it("offers a shell, and opens none, when the peek asked about an earlier pod of the name", async () => {
    useShellAskStore.getState().askFor(peekAsk("cart-a", "uid-deleted"));
    await arrive("/c/prod/pods/shop/cart-a?shell=app");
    await advance(10_000);

    expect(execs()).toEqual([]);
    expect(
      screen.getByRole("button", { name: "Start a shell in app" })
    ).toBeInTheDocument();
  });

  /**
   * Dana went from a pod with a shell to the next one and came Back: the
   * shell had ended with the page, and the page opened another on arrival.
   * Fails if one ask opens two shells. The page is a new one for each pod,
   * so what it offers is a first shell, as on any other arrival.
   */
  it("offers a shell, and opens none, on coming back to the pod whose shell ended with the page", async () => {
    const { router } = await arrive("/c/prod/pods/shop/cart-a");
    keepingShells(router);
    await clickTab(/^Shell/);

    await act(() => router.navigate({ href: "/c/prod/pods/shop/cart-b" }));
    await advance(0);
    expect(useKeptShellStore.getState().shells).toEqual([]);
    await act(() =>
      router.navigate({ href: "/c/prod/pods/shop/cart-a?tab=shell" })
    );
    await advance(0);
    await advance(0);

    expect(execs()).toEqual(["open_pod_shell cart-a"]);
    expect(
      screen.getByText("No shell is running here yet")
    ).toBeInTheDocument();
  });
});

/**
 * Files through a debug container reads that container's `/proc/1/root`,
 * which is the root of whichever container it was pointed at.
 */
describe("a pod's files read through a debug container", () => {
  const INIT = {
    ...APP_CONTAINER,
    name: "init-migrate",
    phase: "init",
    ready: false,
    state: {
      type: "terminated",
      termination: {
        exitCode: 0,
        signal: null,
        reason: "Completed",
        message: null,
        startedAt: "2026-10-06T00:00:00Z",
        finishedAt: "2026-10-06T00:00:04Z",
      },
    },
  };
  const withInit = (name: string) =>
    ({ ...running(name), initContainers: [INIT] }) as PodInfo;
  /** What the cluster says the next debug container sees at its process 1. */
  let seesRootOf: string | null = "app";
  let debuggers = 0;

  beforeEach(() => {
    seesRootOf = "app";
    debuggers = 0;
    useShellAskStore.getState().drop();
    vi.mocked(invoke).mockImplementation(async (command: string, args) => {
      const { name, podName } = args as { name: string; podName: string };
      if (command === "get_pod") return withInit(name);
      if (command === "open_pod_shell") return "term-1";
      if (command === "debug_pod_ephemeral")
        return {
          id: `op-${++debuggers}`,
          operationType: "ephemeral",
          podName,
          containerName: `debugger-${debuggers}`,
          namespace: "shop",
          createdAt: 0,
          timeoutSeconds: 120,
        };
      if (command === "get_debug_status")
        return {
          type: "ready",
          result: {
            podName: "cart-a",
            containerName: `debugger-${debuggers}`,
            namespace: "shop",
            isNewPod: false,
            seesRootOf,
          },
        };
      if (command === "check_access")
        return (args as { queries: AccessQuery[] }).queries.map((query) => ({
          ...query,
          allowed: true,
        }));
      return undefined;
    });
  });

  const listings = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "list_container_files")
      .map(
        ([, args]) => args as { pod: string; container: string; via: unknown }
      );
  const startDebug = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start Debug" }));
    await advance(0);
    await advance(0);
  };
  /** Files, on the finished init container, then its way in through a debug container. */
  const throughDebugFromInit = async () => {
    const arrived = await arrive(
      "/c/prod/pods/shop/cart-a?tab=files",
      <>
        <PodDetail />
        <Toaster />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Read the files" }));
    await advance(0);
    fireEvent.click(screen.getByRole("tab", { name: /^init-migrate/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open through a debug container" })
    );
    await startDebug();
    return arrived;
  };

  /**
   * Dana picked the finished init container and opened it through a debug
   * container; the dialog has no init containers to point at, pointed at app,
   * and the tab listed app's filesystem as init-migrate's. Fails if the tab
   * names any container but the one the debug container was pointed at.
   */
  it("names the container the debug container was pointed at, not the one the tab had open", async () => {
    await throughDebugFromInit();

    expect(
      screen.getByText(/through debug container debugger-1/)
    ).toHaveTextContent("at /proc/1/root of container app.");
    expect(screen.getByRole("tab", { name: /^app/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(listings().at(-1)).toMatchObject({
      container: "app",
      via: { container: "debugger-1", root: "/proc/1/root" },
    });
  });

  /**
   * With one process namespace for the pod, process 1 is the pause container.
   * Fails if its root is listed as a container's, or if nothing says why not.
   */
  it("reads nothing through a debug container whose process 1 is no container's", async () => {
    seesRootOf = null;
    await throughDebugFromInit();

    expect(
      screen.getByText("No container's files to read through debugger-1")
    ).toBeInTheDocument();
    expect(screen.queryByText(/through debug container/)).toBeNull();
    expect(listings().filter((listing) => listing.via !== null)).toEqual([]);
  });

  /**
   * After Files had used a debug container, the page's own Debug button made
   * the next one the Files tab's way in and opened no terminal. Fails if an
   * opening of the dialog inherits what the last one was for.
   */
  it("opens a terminal in the debug container the page's Debug button starts", async () => {
    await throughDebugFromInit();

    fireEvent.click(screen.getByRole("button", { name: "Debug" }));
    await startDebug();

    expect(shellsIn()).toEqual(["debugger-2"]);
    expect(
      screen.getByText(/through debug container debugger-1/)
    ).toBeInTheDocument();
  });

  /**
   * The page stays mounted across a move to another pod. Fails if the next
   * pod's files are read through the last pod's debug container.
   */
  it("does not read the next pod through the last pod's debug container", async () => {
    const { router } = await throughDebugFromInit();

    await act(() =>
      router.navigate({ href: "/c/prod/pods/shop/cart-b?tab=files" })
    );
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Read the files" }));
    await advance(0);
    await advance(0);

    const next = listings().filter((listing) => listing.pod === "cart-b");
    expect(next).not.toEqual([]);
    expect(next.filter((listing) => listing.via !== null)).toEqual([]);
    expect(screen.queryByText(/through debug container/)).toBeNull();
  });
});
