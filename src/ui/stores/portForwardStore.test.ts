import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

interface Request {
  context: string;
  localPort: number;
  remotePort: number;
  autoReconnect: boolean;
}

const portForwardPod = vi.fn(
  async (pod: string, namespace: string, _request: Request) => ({
    id: "pf-1",
    context: "kind-nsname",
    pod,
    namespace,
    localPort: 18080,
    remotePort: 80,
    autoReconnect: true,
    createdAt: "now",
    via: { kind: "pod" as const },
  })
);
const createPortForwardConfig = vi.fn(async () => ({
  id: "cfg-1",
  context: "kind-nsname",
  name: "web:80",
  pod: "web",
  namespace: "default",
  localPort: 18080,
  remotePort: 80,
  autoReconnect: true,
  autoStart: false,
  createdAt: "now",
}));
const stopPortForward = vi.fn(async (_id: string) => undefined);
const portForwardSubscribed = vi.fn(async (_id: string) => undefined);
const listPortForwards = vi.fn(async () => []);

vi.mock("@/lib/commands", () => ({
  commands: {
    portForwardPod: (pod: string, namespace: string, request: Request) =>
      portForwardPod(pod, namespace, request),
    createPortForwardConfig: () => createPortForwardConfig(),
    stopPortForward: (id: string) => stopPortForward(id),
    portForwardSubscribed: (id: string) => portForwardSubscribed(id),
    listPortForwards: () => listPortForwards(),
    listPortForwardConfigs: vi.fn(async () => []),
    deletePortForwardConfig: vi.fn(),
    updatePortForwardConfig: vi.fn(),
  },
}));

import { useClusterStore } from "./clusterStore";
import {
  usePortForwardStore,
  type PortForwardConfig,
} from "./portForwardStore";

beforeEach(() => {
  vi.clearAllMocks();
  usePortForwardStore.setState({
    configs: [],
    sessions: [],
    statusBySession: {},
    failed: [],
    configsLoaded: false,
  });
});

/**
 * A forward the store does not know about is a forward with no Stop button:
 * the Activity panel lists `sessions`, and the pod that started it is the
 * only thing holding the local port. Two of the three ways to start one
 * called the Tauri command straight, so the port stayed held until the app
 * was quit.
 */
describe("a forward that was started is a forward the app can see", () => {
  it("records the session so something can stop it", async () => {
    const session = await usePortForwardStore
      .getState()
      .startPod("web", "default", {
        context: "kind-nsname",
        localPort: 18080,
        remotePort: 80,
        autoReconnect: true,
      });

    expect(portForwardPod).toHaveBeenCalledWith("web", "default", {
      context: "kind-nsname",
      localPort: 18080,
      remotePort: 80,
      autoReconnect: true,
    });
    expect(usePortForwardStore.getState().sessions).toEqual([session]);
  });

  it("does not list the same session twice when a start is repeated", async () => {
    const start = () =>
      usePortForwardStore.getState().startPod("web", "default", {
        context: "kind-nsname",
        localPort: 18080,
        remotePort: 80,
        autoReconnect: true,
      });
    await start();
    await start();
    expect(usePortForwardStore.getState().sessions).toHaveLength(1);
  });

  it("forgets the session once it is stopped", async () => {
    const session = await usePortForwardStore
      .getState()
      .startPod("web", "default", {
        context: "kind-nsname",
        localPort: 18080,
        remotePort: 80,
        autoReconnect: true,
      });
    await usePortForwardStore.getState().stopSession(session.id);

    expect(stopPortForward).toHaveBeenCalledWith(session.id);
    expect(usePortForwardStore.getState().sessions).toEqual([]);
  });

  /**
   * Saving a config and starting a forward are two things, and the dialog
   * used to do only the first while saying it had done the second. The
   * config path has to reach the same command the plain path does.
   */
  it("starting a saved config actually starts it", async () => {
    const config = await usePortForwardStore.getState().addConfig({
      context: "kind-nsname",
      name: "web:80",
      pod: "web",
      namespace: "default",
      localPort: 18080,
      remotePort: 80,
      autoReconnect: true,
      autoStart: false,
    });
    await usePortForwardStore.getState().startConfig(config.id);

    expect(portForwardPod).toHaveBeenCalledWith("web", "default", {
      context: "kind-nsname",
      localPort: 18080,
      remotePort: 80,
      autoReconnect: true,
    });
    expect(usePortForwardStore.getState().sessions).toHaveLength(1);
  });
});

/**
 * A forward says nothing and takes no connection until the app says it is
 * listening: Tauri events have no replay. A start that forgot would leave a
 * forward silent for a minute.
 */
describe("a forward the app started", () => {
  it("is released once the store has recorded it", async () => {
    const session = await usePortForwardStore
      .getState()
      .startPod("web", "default", {
        context: "kind-nsname",
        localPort: 18080,
        remotePort: 80,
        autoReconnect: true,
      });
    expect(portForwardSubscribed).toHaveBeenCalledWith(session.id);
  });
});

/**
 * The backend moves a forward to a replacement pod or ends it on its own;
 * the list has to follow both, or it shows a pod that no longer exists.
 */
describe("a forward the backend moved or ended", () => {
  const running = {
    id: "pf-1",
    context: "kind-nsname",
    pod: "web-old",
    namespace: "default",
    localPort: 18080,
    remotePort: 80,
    autoReconnect: true,
    createdAt: "now",
    via: { kind: "owner" as const, ownerKind: "Deployment", name: "web" },
  };

  it("points at the pod it moved to", () => {
    usePortForwardStore.setState({ sessions: [running] });
    usePortForwardStore.getState().moved("pf-1", "web-new", 8080);
    expect(usePortForwardStore.getState().sessions[0]).toMatchObject({
      pod: "web-new",
      remotePort: 8080,
    });
  });

  it("keeps an ended one, with its reason, until it is dismissed", () => {
    usePortForwardStore.setState({ sessions: [running] });
    const note = { says: "podGone" as const, pod: "web-old" };
    usePortForwardStore.getState().fail("pf-1", note);
    expect(usePortForwardStore.getState().sessions).toEqual([]);
    expect(usePortForwardStore.getState().failed).toEqual([
      { session: running, note },
    ]);
    usePortForwardStore.getState().dismiss("pf-1");
    expect(usePortForwardStore.getState().failed).toEqual([]);
  });
});

/**
 * A saved forward is one cluster's. The start named no cluster and the
 * backend took the window's, so a forward saved for prod and started as the
 * window moved to staging tunnelled `localhost:5432` into staging's pod of
 * the same name.
 */
describe("a cluster's saved forwards", () => {
  const saved = (
    id: string,
    over: Partial<PortForwardConfig> = {}
  ): PortForwardConfig => ({
    id,
    context: "prod",
    name: id,
    pod: `${id}-0`,
    namespace: "db",
    localPort: 15000 + Number(id.at(-1)),
    remotePort: 5432,
    autoReconnect: true,
    autoStart: true,
    createdAt: "now",
    ...over,
  });
  const asked = () => portForwardPod.mock.calls.map(([pod]) => pod);
  /** The window moves to staging while the first start is on its way. */
  const leavingDuringTheFirstStart = () =>
    portForwardPod.mockImplementationOnce(async (pod, namespace) => {
      useClusterStore.setState({ currentContext: "staging" });
      return {
        id: "pf-1",
        context: "prod",
        pod,
        namespace,
        localPort: 15001,
        remotePort: 5432,
        autoReconnect: true,
        createdAt: "now",
        via: { kind: "pod" as const },
      };
    });

  beforeEach(() => {
    useClusterStore.setState({ currentContext: "prod" });
    usePortForwardStore.setState({
      configs: [saved("pg1"), saved("pg2"), saved("pg3")],
    });
  });

  /** Fails if a start leaves the cluster to whatever the window is on when it arrives. */
  it("are each started on the cluster they were saved for, by name", async () => {
    useClusterStore.setState({ currentContext: "staging" });
    await usePortForwardStore.getState().startConfig("pg1");

    expect(portForwardPod).toHaveBeenCalledWith(
      "pg1-0",
      "db",
      expect.objectContaining({ context: "prod" })
    );
  });

  /**
   * Auto-start runs on landing and Start all on a click; both start one
   * forward per round trip, and Ctrl+Tab is quicker than that. Fails if
   * either goes on starting forwards after the window has left the cluster.
   */
  it.each(["startAutoForContext", "startAllForContext"] as const)(
    "stop being started by %s once the window has left their cluster",
    async (starter) => {
      leavingDuringTheFirstStart();

      const result = await usePortForwardStore.getState()[starter]("prod");

      expect(asked()).toEqual(["pg1-0"]);
      expect(result).toEqual({ started: 1, skipped: 0, failed: 0 });
    }
  );

  /** The whole set, while the window stays. Fails if the check on the window stops a start it should not. */
  it("are all started while the window stays on their cluster, and no other cluster's", async () => {
    usePortForwardStore.setState((state) => ({
      configs: [...state.configs, saved("pg4", { context: "staging" })],
    }));

    const result = await usePortForwardStore
      .getState()
      .startAutoForContext("prod");

    expect(asked()).toEqual(["pg1-0", "pg2-0", "pg3-0"]);
    expect(result.started).toBe(3);
  });
});
