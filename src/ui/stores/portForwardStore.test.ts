import { describe, it, expect, vi, beforeEach } from "vitest";

interface Request {
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
const listPortForwards = vi.fn(async () => []);

vi.mock("@/lib/commands", () => ({
  commands: {
    portForwardPod: (pod: string, namespace: string, request: Request) =>
      portForwardPod(pod, namespace, request),
    createPortForwardConfig: () => createPortForwardConfig(),
    stopPortForward: (id: string) => stopPortForward(id),
    listPortForwards: () => listPortForwards(),
    listPortForwardConfigs: vi.fn(async () => []),
    deletePortForwardConfig: vi.fn(),
    updatePortForwardConfig: vi.fn(),
  },
}));

import { usePortForwardStore } from "./portForwardStore";

beforeEach(() => {
  vi.clearAllMocks();
  usePortForwardStore.setState({
    configs: [],
    sessions: [],
    statusBySession: {},
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
        localPort: 18080,
        remotePort: 80,
        autoReconnect: true,
      });

    expect(portForwardPod).toHaveBeenCalledWith("web", "default", {
      localPort: 18080,
      remotePort: 80,
      autoReconnect: true,
    });
    expect(usePortForwardStore.getState().sessions).toEqual([session]);
  });

  it("does not list the same session twice when a start is repeated", async () => {
    const start = () =>
      usePortForwardStore.getState().startPod("web", "default", {
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
      localPort: 18080,
      remotePort: 80,
      autoReconnect: true,
    });
    expect(usePortForwardStore.getState().sessions).toHaveLength(1);
  });
});
