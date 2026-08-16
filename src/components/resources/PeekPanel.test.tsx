import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ConfigMapInfo,
  CustomResourceDetailInfo,
  EndpointsInfo,
  EventInfo,
  ObjectRef,
  PodInfo,
  ResourceConnections,
  ServiceInfo,
} from "@/generated/types";

// CodeMirror is loaded behind React.lazy and has nothing to prove here; the
// panel's job is to hand it a manifest.
vi.mock("@/components/yaml", () => ({
  YamlEditor: ({ value }: { value: string }) => (
    <pre data-testid="yaml-editor">{value}</pre>
  ),
}));

// The vendors' answers, controllable per test: the default is the shape the
// real hooks answer on a cluster with nothing installed, so every other test
// reads exactly as before.
const servicesRoutesSpy = vi.fn();
vi.mock("@/hooks/useServiceRoutes", () => ({
  useServiceRoutes: () => ({
    available: false,
    routes: [],
    isPending: false,
    error: null,
  }),
  useServicesRoutes: (services: unknown) =>
    servicesRoutesSpy(services) ?? {
      available: false,
      routes: new Map(),
      isPending: false,
    },
  useProxyBehind: () => null,
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
    getClusterInfo: vi.fn(),
    getEndpoints: vi.fn(),
    deletePod: vi.fn(),
    restartPod: vi.fn(),
    getCustomResource: vi.fn(),
    getCustomResourceYaml: vi.fn(),
    getService: vi.fn(),
    getResourceConnections: vi.fn(),
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
import { TooltipProvider } from "@/components/ui/tooltip";
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
      phase: "Running",
      display: "CrashLoopBackOff",
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
        lastTerminated: null,
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
    lastRestartAt: null,
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

const APPLICATION_MANIFEST = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shop
`;

function buildApplication(): CustomResourceDetailInfo {
  return {
    name: "shop",
    namespace: "argocd",
    uid: "app-uid",
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    spec: { project: "default", destination: { namespace: "shop" } },
    status: {
      health: { status: "Degraded" },
      conditions: [{ type: "Ready", status: "False" }],
    },
    labels: { "app.kubernetes.io/part-of": "storefront" },
    annotations: {},
    createdAt: "2026-08-01T09:00:00Z",
    ownerReferences: [],
    finalizers: [],
    resourceVersion: "41",
  };
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

function buildServiceInfo(): ServiceInfo {
  return {
    name: "frontend",
    namespace: "ambassadors",
    uid: "svc-uid",
    type: "ClusterIP",
    sessionAffinity: "None",
    clusterIp: "10.10.19.25",
    externalIps: [],
    loadBalancerIps: [],
    ports: [
      {
        name: null,
        port: 3000,
        targetPort: "3000",
        nodePort: null,
        protocol: "TCP",
      },
    ],
    selector: { app: "frontend" },
    labels: {},
    annotations: {},
    createdAt: "2026-08-01T00:00:00Z",
  };
}

function buildEndpointsInfo(): EndpointsInfo {
  return {
    name: "frontend",
    namespace: "ambassadors",
    subsets: [],
    createdAt: "2026-08-01T00:00:00Z",
    overCapacity: false,
  };
}

const objRef = (kind: string, name: string, namespace: string): ObjectRef => ({
  kind,
  name,
  namespace,
  existence: "present",
  facts: null,
});

function buildConnections(
  edges: ResourceConnections["edges"] = []
): ResourceConnections {
  return {
    subject: objRef("Service", "frontend", "ambassadors"),
    edges,
    stops: [],
    published: [],
    notLookedAt: [],
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

/** The words on the strip, without the glyph or the count beside them. */
const tabNames = () =>
  screen
    .getAllByRole("tab")
    .map((tab) => tab.querySelector("span")?.textContent);

const openTab = (name: string) =>
  userEvent.click(screen.getByRole("tab", { name }));

const wrap = (entry: string, ui: ReactNode = <PeekPanel />) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      {/* The shell mounts one of these around the whole app; a disabled
          action's reason rides in a tooltip and needs it. */}
      <TooltipProvider>
        <MemoryRouter initialEntries={[entry]}>
          {ui}
          <Probe />
        </MemoryRouter>
      </TooltipProvider>
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
    .mockResolvedValue({
      values: { "nginx.conf": "worker_processes 1;" },
      withheld: {},
      binary: {},
    });
  vi.mocked(commands.streamPodLogs).mockReset().mockResolvedValue("stream-1");
  vi.mocked(commands.stopLogStream).mockReset().mockResolvedValue(undefined);
  vi.mocked(commands.logStreamSubscribed)
    .mockReset()
    .mockResolvedValue(undefined);
  vi.mocked(commands.deletePod).mockReset().mockResolvedValue(undefined);
  vi.mocked(commands.restartPod).mockReset().mockResolvedValue(undefined);
  vi.mocked(commands.getCustomResource)
    .mockReset()
    .mockResolvedValue(buildApplication());
  vi.mocked(commands.getCustomResourceYaml)
    .mockReset()
    .mockResolvedValue(APPLICATION_MANIFEST);
  vi.mocked(commands.getService)
    .mockReset()
    .mockResolvedValue(buildServiceInfo());
  vi.mocked(commands.getEndpoints)
    .mockReset()
    .mockResolvedValue(buildEndpointsInfo());
  vi.mocked(commands.getResourceConnections)
    .mockReset()
    .mockResolvedValue(buildConnections());
  servicesRoutesSpy.mockReset();
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
    // The image is split into repository and tag, so it is matched by the
    // copy button that carries the whole reference.
    expect(
      screen.getByRole("button", { name: "Copy image busybox:1.36" })
    ).toBeInTheDocument();
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

describe("PeekPanel tab strip", () => {
  beforeEach(mockCluster);

  // The same rule the detail pages are drawn by: a strip where some tabs
  // carry a glyph and others do not is worse than a strip with none.
  it("gives every tab one glyph, and exactly one, on both kinds", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
    }

    cleanup();
    wrap(CONFIGMAP_PEEK);
    await screen.findByRole("tab", { name: /Data/ });
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
    }
  });

  it("counts what it is already holding, and fetches nothing to do it", async () => {
    wrap(CONFIGMAP_PEEK);
    const data = await screen.findByRole("tab", { name: /Data/ });
    await waitFor(() => expect(data).toHaveTextContent("Data1"));
    expect(data).toHaveAttribute("title", "Data — 1");
    // The keys came with the summary; the values did not, and are still
    // unread until the tab is opened.
    expect(commands.getConfigmapData).not.toHaveBeenCalled();
  });
});

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
          display: "Pending",
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
            started: false,
            phase: "app",
            state: { type: "waiting", reason: "ContainerCreating" },
            lastTerminated: null,
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

/**
 * The peek used to stop at the registry: `open` was a no-op for a kind it
 * could not spell, and the panel's fetch would have asked the core API for
 * `/api/v1/applications` even if it had opened. Both halves are the CRD.
 */
describe("PeekPanel on a custom resource", () => {
  beforeEach(mockCluster);

  const APP_PEEK =
    "/events?peek=applications.argoproj.io/Application/argocd/shop";

  it("reads it through its CRD rather than the core API", async () => {
    wrap(APP_PEEK);
    await waitFor(() =>
      expect(commands.getCustomResource).toHaveBeenCalledWith(
        "applications.argoproj.io",
        "shop",
        "argocd"
      )
    );
    expect(commands.getManifest).not.toHaveBeenCalled();
  });

  it("names the object and its kind in the header", async () => {
    wrap(APP_PEEK);
    expect(await screen.findByText("shop")).toBeInTheDocument();
    // Twice by design: the reference announces the kind to a screen reader
    // because it draws it as a glyph, and the line under it prints it.
    expect(screen.getAllByText("Application").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Application shop" })
    ).toHaveAttribute(
      "href",
      "/customresourcedefinitions/applications.argoproj.io/instances/argocd/shop"
    );
  });

  /**
   * Nothing here knows what Argo is. `status.health.status` is drawn because
   * every scalar under `status` is, not because this file recognises it.
   */
  it("draws the operator's status without understanding it", async () => {
    wrap(APP_PEEK);
    expect(await screen.findByText("health.status")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
  });

  /** A `Ready` condition is the nearest thing to a universal verdict. */
  it("badges it from a Ready condition where there is no phase", async () => {
    wrap(APP_PEEK);
    expect(await screen.findByText("Not ready")).toBeInTheDocument();
  });

  it("offers its own page, which for a custom resource is the CRD's", async () => {
    wrap(APP_PEEK);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open full page/ })
    );
    expect(location()).toBe(
      "/customresourcedefinitions/applications.argoproj.io/instances/argocd/shop"
    );
  });

  it("reads the manifest through the CRD too", async () => {
    wrap(APP_PEEK);
    await openTab("YAML");
    await waitFor(() =>
      expect(commands.getCustomResourceYaml).toHaveBeenCalledWith(
        "applications.argoproj.io",
        "shop",
        "argocd"
      )
    );
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
    // Its count rides in the accessible name once the summary lands.
    await screen.findByRole("tab", { name: /^Data/ });
    await userEvent.click(screen.getByText("peek other pod"));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    );
  });
});

const PENDING_POD = buildPod({
  name: "unschedulable-demo",
  status: {
    phase: "Pending",
    display: "Pending",
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
      started: false,
      phase: "app",
      state: { type: "waiting", reason: "ContainerCreating" },
      lastTerminated: null,
      restartCount: 0,
      ports: [{ name: null, containerPort: 8080, protocol: "TCP" }],
      env: [],
      envFrom: [],
    },
  ],
} as Partial<PodInfo>);

const RUNNING_POD = buildPod({
  name: "log-demo-1",
  status: {
    phase: "Running",
    display: "Running",
    ready: true,
    conditions: [],
    message: null,
    reason: null,
  },
  restartCount: 0,
  containers: [
    {
      name: "app",
      image: "busybox:1.36",
      ready: true,
      started: true,
      phase: "app",
      state: { type: "running" },
      lastTerminated: null,
      restartCount: 0,
      ports: [{ name: null, containerPort: 8080, protocol: "TCP" }],
      env: [],
      envFrom: [],
    },
  ],
} as Partial<PodInfo>);

const RUNNING_PEEK = "/events?peek=pods/k8s-gui-test/log-demo-1";

const openMore = () =>
  userEvent.click(screen.getByRole("button", { name: /More actions/ }));

describe("PeekPanel actions", () => {
  beforeEach(mockCluster);

  it("offers a pod's work up front and its destructive end behind a menu", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    expect(screen.getByRole("button", { name: /^Shell/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Port forward/ })
    ).toBeInTheDocument();
    // Not on the row until the menu is opened.
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();

    await openMore();
    expect(
      await screen.findByRole("menuitem", { name: /Delete/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Restart/ })).toBeVisible();
  });

  // A dead button teaches nothing. The control stays reachable and carries
  // the reason, which is the answer to the question the click was asking.
  it("says why a pending pod cannot be shelled into or forwarded", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(PENDING_POD);
    wrap("/events?peek=pods/k8s-gui-test/unschedulable-demo");
    await screen.findByText("Pending");

    const shell = screen.getByRole("button", { name: /^Shell/ });
    expect(shell).toHaveAttribute("aria-disabled", "true");
    expect(shell).not.toBeDisabled();

    await userEvent.hover(shell);
    // Radix renders the reason twice: once visibly, once for the screen
    // reader it describes the trigger to.
    expect(
      await screen.findAllByText(/No container is running yet/)
    ).not.toHaveLength(0);

    const forward = screen.getByRole("button", { name: /Port forward/ });
    expect(forward).toHaveAttribute("aria-disabled", "true");
    await userEvent.hover(forward);
    expect(
      await screen.findAllByText(/Nothing is listening yet/)
    ).not.toHaveLength(0);
  });

  it("takes a shell request to the page where a terminal fits", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await userEvent.click(screen.getByRole("button", { name: /^Shell/ }));
    expect(location()).toBe("/pods/k8s-gui-test/log-demo-1?shell=app");
  });

  it("names the object and the consequence before deleting it", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));

    expect(
      await screen.findByText("Delete pod k8s-gui-test/log-demo-1?")
    ).toBeInTheDocument();
    expect(screen.getByText(/will start a replacement/)).toBeInTheDocument();

    // Cancelling leaves both the object and the panel exactly where they were.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commands.deletePod).not.toHaveBeenCalled();
    expect(location()).toBe(RUNNING_PEEK);
  });

  // A peek onto an object that no longer exists is a ghost.
  it("closes itself once the object it is showing is gone", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    vi.mocked(commands.deletePod).mockResolvedValue(undefined);
    wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    await userEvent.type(
      await screen.findByLabelText(/to confirm/),
      "log-demo-1"
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(location()).toBe("/events"));
    expect(commands.deletePod).toHaveBeenCalledWith(
      "log-demo-1",
      "k8s-gui-test",
      false
    );
  });

  it("keeps the panel open across a restart", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    vi.mocked(commands.restartPod).mockResolvedValue(undefined);
    wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Restart/ }));

    await waitFor(() =>
      expect(commands.restartPod).toHaveBeenCalledWith(
        "log-demo-1",
        "k8s-gui-test"
      )
    );
    expect(location()).toBe(RUNNING_PEEK);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // Restarting a pod nothing owns is a deletion; it has to be confirmed, and
  // it must not read like a Deployment's rolling restart.
  it("gates a bare pod's restart behind the same confirmation a delete gets", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(
      buildPod({ ...RUNNING_POD, ownerReferences: [] } as Partial<PodInfo>)
    );
    wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Restart \(deletes it\)/ })
    );
    expect(
      await screen.findByText(/nothing will recreate it/)
    ).toBeInTheDocument();
    expect(commands.restartPod).not.toHaveBeenCalled();
  });

  it("gives a ConfigMap the one action it has", async () => {
    wrap(CONFIGMAP_PEEK);
    await screen.findByRole("tab", { name: "Data" });
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
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

/**
 * One chain, read top to bottom: the ways in above the object, the object
 * itself in the middle, what answers below it. The two flat headings this
 * replaced said the same order in words and looked like leftover prose.
 */
describe("PeekPanel traffic chain", () => {
  beforeEach(mockCluster);

  const SERVICE_PEEK = "/events?peek=services/ambassadors/frontend";

  /** Passes when `above` sits earlier in the document than `below`. */
  const expectAbove = (above: Element, below: Element) =>
    expect(
      above.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

  it("hangs a Service between its way in and its addresses", async () => {
    vi.mocked(commands.getResourceConnections).mockResolvedValue(
      buildConnections([
        {
          from: objRef("Ingress", "frontend-ing", "ambassadors"),
          to: objRef("Service", "frontend", "ambassadors"),
          relation: {
            verb: "routes",
            host: "ambassadors.sketchar.io",
            path: "/",
            pathType: "Prefix",
            port: "3000",
            tls: true,
          },
        },
      ])
    );
    wrap(SERVICE_PEEK);

    expect(await screen.findByText("Traffic path")).toBeInTheDocument();
    const ingress = await screen.findByRole("link", {
      name: "Ingress frontend-ing",
    });
    const self = screen.getByText(/this Service/);
    const endpoints = screen.getByRole("link", { name: "Endpoints frontend" });
    expectAbove(ingress, self);
    expectAbove(self, endpoints);
    // One dot in the chain is haloed: the one the reader is standing on.
    expect(screen.getAllByTestId("rail-here")).toHaveLength(1);
    // Every segment ends in an arrowhead — three hops, two arrows, all down.
    expect(screen.getAllByTestId("rail-arrow")).toHaveLength(2);
    // The rule's host rides on the hop, so it says which door this is.
    expect(screen.getByText("ambassadors.sketchar.io")).toBeInTheDocument();
    // The words the chain replaced stay gone.
    expect(screen.queryByText("Reached through")).toBeNull();
    expect(screen.queryByText("Behind it")).toBeNull();
  });

  it("puts the Service in front above a Pod, and nothing below it", async () => {
    vi.mocked(commands.getResourceConnections).mockResolvedValue(
      buildConnections([
        {
          from: objRef("Service", "crash-svc", "k8s-gui-test"),
          to: objRef("Pod", "crash-demo-56588f6b8c-8bj9v", "k8s-gui-test"),
          relation: { verb: "selects", selector: "app=crash" },
        },
      ])
    );
    wrap(POD_PEEK);

    const service = await screen.findByRole("link", {
      name: "Service crash-svc",
    });
    const self = screen.getByText(/this Pod/);
    expectAbove(service, self);
    expect(screen.getByText(/the Service in front/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Endpoints/ })).toBeNull();
  });

  /**
   * The level above the Service in front: a Pod behind a Service that an
   * IngressRoute serves used to show the Service as the top of the world,
   * because the vendors were only ever asked about a peeked Service itself.
   */
  it("asks the vendors about the Services in front of a Pod", async () => {
    vi.mocked(commands.getResourceConnections).mockResolvedValue(
      buildConnections([
        {
          from: objRef("Service", "crash-svc", "k8s-gui-test"),
          to: objRef("Pod", "crash-demo-56588f6b8c-8bj9v", "k8s-gui-test"),
          relation: { verb: "selects", selector: "app=crash" },
        },
      ])
    );
    servicesRoutesSpy.mockImplementation((services: unknown[]) =>
      services.length === 0
        ? undefined
        : {
            available: true,
            isPending: false,
            routes: new Map([
              [
                "k8s-gui-test/crash-svc",
                [
                  {
                    host: "crash.example.com",
                    path: "/",
                    tls: true,
                    source: {
                      kind: "IngressRoute",
                      name: "crash-route",
                      namespace: "k8s-gui-test",
                      crd: "ingressroutes.traefik.io",
                    },
                  },
                ],
              ],
            ]),
          }
    );
    wrap(POD_PEEK);

    const route = await screen.findByRole("link", {
      name: "IngressRoute crash-route",
    });
    const service = screen.getByRole("link", { name: "Service crash-svc" });
    expectAbove(route, service);
    expectAbove(service, screen.getByText(/this Pod/));
    expect(servicesRoutesSpy).toHaveBeenCalledWith([
      { namespace: "k8s-gui-test", name: "crash-svc" },
    ]);
  });

  it("names the Service an Endpoints publishes for, above it", async () => {
    wrap("/events?peek=endpoints/ambassadors/frontend");

    const service = await screen.findByRole("link", {
      name: "Service frontend",
    });
    const self = screen.getByText(/this Endpoints/);
    expectAbove(service, self);
    expect(
      screen.getByText(/the Service these endpoints publish/)
    ).toBeInTheDocument();
  });

  it("stays silent for a pod nothing routes", async () => {
    wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(screen.queryByText("Traffic path")).toBeNull();
  });
});
