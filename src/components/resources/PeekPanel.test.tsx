import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConfigMapInfo, EventInfo, PodInfo } from "@/generated/types";

// CodeMirror is loaded behind React.lazy and has nothing to prove here; the
// panel's job is to hand it a manifest.
vi.mock("@/components/yaml", () => ({
  YamlEditor: ({ value }: { value: string }) => (
    <pre data-testid="yaml-editor">{value}</pre>
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getPod: vi.fn(),
    getManifest: vi.fn(),
    listEvents: vi.fn(),
    getConfigmap: vi.fn(),
    getConfigmapData: vi.fn(),
    getDeployment: vi.fn(),
    getDeploymentPods: vi.fn(),
    streamPodLogs: vi.fn(),
    stopLogStream: vi.fn(),
    logStreamSubscribed: vi.fn(),
    getPodLogs: vi.fn(),
  },
}));

const NAMESPACE_MANIFEST = `apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    tier: control
status:
  phase: Active
`;

import { commands } from "@/lib/commands";
import { usePeek, type PeekTarget } from "@/hooks/usePeek";
import {
  PEEK_WIDTH_DEFAULT,
  useDisplaySettingsStore,
} from "@/stores/displaySettingsStore";
import { PeekPanel } from "./PeekPanel";

function buildPod(overrides: Partial<PodInfo> = {}): PodInfo {
  return {
    name: "crash-demo-56588f6b8c-8bj9v",
    namespace: "k8s-gui-test",
    uid: "pod-uid",
    status: {
      phase: "CrashLoopBackOff",
      ready: false,
      conditions: [],
      message: null,
      reason: null,
    },
    nodeName: "k3d-agent-0",
    podIp: "10.42.0.46",
    hostIp: "172.18.0.3",
    containers: [
      {
        name: "app",
        image: "busybox:1.36",
        ready: false,
        state: { running: null, waiting: null, terminated: null },
        restartCount: 137,
        ports: [],
        env: [],
        envFrom: [],
      },
    ],
    labels: {},
    annotations: {},
    createdAt: "2026-08-05T00:00:00Z",
    restartCount: 137,
    cpuRequests: null,
    cpuLimits: "100m",
    memoryRequests: null,
    memoryLimits: null,
    ownerReferences: [
      {
        api_version: "apps/v1",
        kind: "ReplicaSet",
        name: "crash-demo-56588f6b8c",
        uid: "rs-uid",
        controller: true,
      },
    ],
    ...overrides,
  } as PodInfo;
}

function buildEvent(): EventInfo {
  return {
    name: "crash-demo.1",
    namespace: "k8s-gui-test",
    uid: "event-uid",
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container",
    source: "kubelet",
    involvedObject: {
      kind: "Pod",
      name: "crash-demo-56588f6b8c-8bj9v",
      namespace: "k8s-gui-test",
      uid: "pod-uid",
    },
    count: 3832,
    firstTimestamp: "2026-08-05T00:00:00Z",
    lastTimestamp: "2026-08-05T00:10:00Z",
  } as EventInfo;
}

function buildConfigMap(): ConfigMapInfo {
  return {
    name: "app-config",
    namespace: "k8s-gui-test",
    uid: "cm-uid",
    dataKeys: ["nginx.conf"],
    labels: {},
    annotations: {},
    createdAt: "2026-08-05T00:00:00Z",
  };
}

function Probe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

/** Lets a test move the peek to another object the way a row click would. */
function PeekOpener({ target, label }: { target: PeekTarget; label: string }) {
  const { open } = usePeek();
  return (
    <button type="button" onClick={() => open(target)}>
      {label}
    </button>
  );
}

const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

const openTab = (name: string) =>
  userEvent.click(screen.getByRole("tab", { name }));

const wrap = (entry: string, ui: ReactNode = <PeekPanel />) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        {ui}
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

const location = () => screen.getByTestId("location").textContent;
const POD_PEEK = "/events?peek=pods/k8s-gui-test/crash-demo-56588f6b8c-8bj9v";

function mockCluster() {
  vi.mocked(commands.getPod).mockReset().mockResolvedValue(buildPod());
  vi.mocked(commands.getManifest)
    .mockReset()
    .mockResolvedValue(NAMESPACE_MANIFEST);
  vi.mocked(commands.listEvents).mockReset().mockResolvedValue([buildEvent()]);
  vi.mocked(commands.getConfigmap)
    .mockReset()
    .mockResolvedValue(buildConfigMap());
  vi.mocked(commands.getConfigmapData)
    .mockReset()
    .mockResolvedValue({ "nginx.conf": "worker_processes 1;" });
  vi.mocked(commands.streamPodLogs).mockReset().mockResolvedValue("stream-1");
  vi.mocked(commands.stopLogStream).mockReset().mockResolvedValue(undefined);
  vi.mocked(commands.logStreamSubscribed)
    .mockReset()
    .mockResolvedValue(undefined);
  useDisplaySettingsStore.setState({ peekWidth: PEEK_WIDTH_DEFAULT });
}

describe("PeekPanel", () => {
  beforeEach(mockCluster);

  it("stays out of the way when nothing is peeked", () => {
    wrap("/events");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commands.getPod).not.toHaveBeenCalled();
  });

  // The header comes from the URL, so the panel is never an empty box that
  // fills in and shifts under the reader's eye.
  it("names the object before the fetch resolves", () => {
    vi.mocked(commands.getPod).mockReturnValue(new Promise(() => {}));
    wrap(POD_PEEK);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "crash-demo-56588f6b8c-8bj9v"
    );
    expect(screen.getByTestId("peek-skeleton")).toBeInTheDocument();
  });

  it("shows the summary and this object's events once they arrive", async () => {
    wrap(POD_PEEK);
    expect(await screen.findByText("CrashLoopBackOff")).toBeInTheDocument();
    expect(screen.getByText("10.42.0.46")).toBeInTheDocument();
    expect(screen.getByText("0 of 1 ready")).toBeInTheDocument();
    expect(screen.getByText("busybox:1.36")).toBeInTheDocument();
    expect(await screen.findByText("BackOff")).toBeInTheDocument();

    expect(commands.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        involved_object_kind: "Pod",
        involved_object_name: "crash-demo-56588f6b8c-8bj9v",
        namespace: "k8s-gui-test",
      })
    );
  });

  it("says what failed and keeps offering the full page", async () => {
    vi.mocked(commands.getPod).mockRejectedValue(new Error("pods not found"));
    wrap(POD_PEEK);
    expect(await screen.findByText(/pods not found/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open full page/ })
    ).toBeInTheDocument();
  });

  it("leaves for the full page and closes behind itself", async () => {
    wrap(POD_PEEK);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open full page/ })
    );
    expect(location()).toBe("/pods/k8s-gui-test/crash-demo-56588f6b8c-8bj9v");
  });

  // Radix owns Escape; a second listener here would close it twice.
  it("closes on Escape by dropping the parameter", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(location()).toBe("/events"));
  });

  it("replaces its contents when a reference inside it is clicked", async () => {
    wrap(POD_PEEK);
    await userEvent.click(
      await screen.findByRole("link", { name: /k3d-agent/ })
    );
    await waitFor(() =>
      expect(location()).toBe("/events?peek=nodes%2Fk3d-agent-0")
    );
  });

  it("falls back to the manifest for a kind with no detail command", async () => {
    wrap("/events?peek=namespaces/kube-system");
    // The badge and the status row both read the phase out of the manifest.
    expect(await screen.findAllByText("Active")).toHaveLength(2);
    expect(commands.getManifest).toHaveBeenCalledWith(
      "Namespace",
      "v1",
      "kube-system",
      null
    );
    // The manifest becomes rows, not a wall of YAML.
    expect(screen.getByText("phase")).toBeInTheDocument();
    expect(screen.getByText("tier")).toBeInTheDocument();
    expect(screen.getByText("control")).toBeInTheDocument();
  });
});

const CONFIGMAP_PEEK = "/events?peek=configmaps/k8s-gui-test/app-config";

describe("PeekPanel tabs", () => {
  beforeEach(mockCluster);

  it("offers only the surfaces the kind actually has", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(tabNames()).toEqual(["Overview", "Logs", "Containers", "YAML"]);

    cleanup();
    wrap(CONFIGMAP_PEEK);
    await screen.findByRole("tab", { name: "Data" });
    expect(tabNames()).toEqual(["Overview", "Data", "YAML"]);
  });

  // A peek is opened dozens of times an hour. If every open cost a manifest
  // read and a log stream, the panel would be slower than the page it saves.
  it("fetches nothing but the summary until a tab is opened", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(commands.getManifest).not.toHaveBeenCalled();
    expect(commands.streamPodLogs).not.toHaveBeenCalled();

    await openTab("YAML");
    await waitFor(() => expect(commands.getManifest).toHaveBeenCalled());
    expect(commands.streamPodLogs).not.toHaveBeenCalled();
  });

  it("renders the manifest under the YAML tab", async () => {
    vi.mocked(commands.getManifest).mockResolvedValue("kind: Pod\n");
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    await openTab("YAML");
    expect(await screen.findByTestId("yaml-editor")).toHaveTextContent(
      "kind: Pod"
    );
  });

  it("says what failed on the YAML tab and offers a retry", async () => {
    vi.mocked(commands.getManifest).mockRejectedValue(
      new Error("manifest denied")
    );
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    await openTab("YAML");
    expect(await screen.findByText(/manifest denied/)).toBeInTheDocument();

    vi.mocked(commands.getManifest).mockResolvedValue("kind: Pod\n");
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByTestId("yaml-editor")).toBeInTheDocument();
  });

  it("streams a running pod's logs", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    await openTab("Logs");
    await waitFor(() => expect(commands.streamPodLogs).toHaveBeenCalled());
    expect(vi.mocked(commands.streamPodLogs).mock.calls[0][0]).toMatchObject({
      podName: "crash-demo-56588f6b8c-8bj9v",
      namespace: "k8s-gui-test",
      container: "app",
    });
  });

  // An empty black pane is indistinguishable from a broken one; a pod whose
  // containers never started has to say so instead.
  it("explains the silence rather than opening an empty log pane", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(
      buildPod({
        name: "unschedulable-demo",
        status: {
          phase: "Pending",
          ready: false,
          conditions: [],
          message: "0/3 nodes are available: insufficient cpu.",
          reason: "Unschedulable",
        },
        restartCount: 0,
        containers: [
          {
            name: "app",
            image: "busybox:1.36",
            ready: false,
            state: { type: "waiting", reason: "ContainerCreating" },
            restartCount: 0,
            ports: [],
            env: [],
            envFrom: [],
          },
        ],
      } as Partial<PodInfo>)
    );
    wrap("/events?peek=pods/k8s-gui-test/unschedulable-demo");
    await screen.findByText("Pending");
    await openTab("Logs");

    expect(
      await screen.findByText(/No container has started/)
    ).toBeInTheDocument();
    expect(screen.getByText(/0\/3 nodes are available/)).toBeInTheDocument();
    expect(commands.streamPodLogs).not.toHaveBeenCalled();
  });

  it("reads a ConfigMap's values only once the Data tab is opened", async () => {
    wrap(CONFIGMAP_PEEK);
    await screen.findByRole("tab", { name: "Data" });
    expect(commands.getConfigmapData).not.toHaveBeenCalled();

    await openTab("Data");
    expect(await screen.findByText("nginx.conf")).toBeInTheDocument();
    expect(await screen.findByText("worker_processes 1;")).toBeInTheDocument();
  });

  it("says what failed on the Data tab and offers a retry", async () => {
    vi.mocked(commands.getConfigmapData).mockRejectedValue(
      new Error("configmaps is forbidden")
    );
    wrap(CONFIGMAP_PEEK);
    await openTab("Data");
    expect(
      await screen.findByText(/configmaps is forbidden/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});

describe("PeekPanel tab persistence", () => {
  beforeEach(mockCluster);

  const OTHER_POD: PeekTarget = {
    kind: "Pod",
    name: "log-demo-1",
    namespace: "k8s-gui-test",
  };
  const CONFIG_MAP: PeekTarget = {
    kind: "ConfigMap",
    name: "app-config",
    namespace: "k8s-gui-test",
  };

  const withOpeners = (
    <>
      <PeekPanel />
      <PeekOpener target={OTHER_POD} label="peek other pod" />
      <PeekOpener target={CONFIG_MAP} label="peek configmap" />
    </>
  );

  it("stays on Logs when the next target is another pod", async () => {
    wrap(POD_PEEK, withOpeners);
    await screen.findByText("CrashLoopBackOff");
    await openTab("Logs");

    await userEvent.click(screen.getByText("peek other pod"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    );
  });

  it("falls back to Overview when the next target has no such tab", async () => {
    wrap(POD_PEEK, withOpeners);
    await screen.findByText("CrashLoopBackOff");
    await openTab("Logs");

    await userEvent.click(screen.getByText("peek configmap"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    );
    expect(screen.queryByRole("tab", { name: "Logs" })).toBeNull();
  });

  it("returns to Logs on the next pod, having only borrowed Overview", async () => {
    wrap(POD_PEEK, withOpeners);
    await screen.findByText("CrashLoopBackOff");
    await openTab("Logs");

    await userEvent.click(screen.getByText("peek configmap"));
    await screen.findByRole("tab", { name: "Data" });
    await userEvent.click(screen.getByText("peek other pod"));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    );
  });
});

describe("PeekPanel width", () => {
  beforeEach(mockCluster);

  const handle = () => screen.getByTestId("peek-resize-handle");
  const panelWidth = () => screen.getByRole("dialog").style.width;

  it("opens at the stored width", async () => {
    useDisplaySettingsStore.setState({ peekWidth: 620 });
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(panelWidth()).toBe("620px");
  });

  it("is resizable from the keyboard, not only by dragging", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    handle().focus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(useDisplaySettingsStore.getState().peekWidth).toBe(
      PEEK_WIDTH_DEFAULT + 16
    );
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(useDisplaySettingsStore.getState().peekWidth).toBe(
      PEEK_WIDTH_DEFAULT - 16
    );
    expect(panelWidth()).toBe(`${PEEK_WIDTH_DEFAULT - 16}px`);
  });

  it("announces its bounds to a screen reader", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
    expect(handle()).toHaveAttribute("aria-valuenow", `${PEEK_WIDTH_DEFAULT}`);
    expect(handle()).toHaveAttribute("aria-valuemin", "360");
  });

  // jsdom reports a 1024px window; the panel has to leave the list behind it
  // something to be.
  it("never grows past what the window can spare", async () => {
    useDisplaySettingsStore.setState({ peekWidth: 1200 });
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(panelWidth()).toBe("784px");
  });
});
