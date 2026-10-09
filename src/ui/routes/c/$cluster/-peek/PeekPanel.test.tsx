import { load } from "js-yaml";
import type { ReactNode } from "react";
import {
  beforeAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import type {
  ConfigMapInfo,
  CustomResourceDetailInfo,
  EndpointsInfo,
  EventInfo,
  ObjectRef,
  PodInfo,
  ReplicaSetInfo,
  ResourceConnections,
  ServiceInfo,
} from "@/generated/types";

// CodeMirror is loaded behind React.lazy and has nothing to prove here; the
// panel's job is to hand it a manifest.
vi.mock("../-yaml", () => ({
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
      error: null,
    },
  useProxyBehind: () => null,
}));

vi.mock("../-object/AlertsAbout", () => ({
  AlertsAbout: ({ kind, name }: { kind: string; name: string }) => (
    <p>{`alerts about ${kind} ${name}`}</p>
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getPod: vi.fn(),
    getManifest: vi.fn(),
    getServedObject: vi.fn(),
    listEvents: vi.fn(),
    getConfigmap: vi.fn(),
    getConfigmapData: vi.fn(),
    getDeployment: vi.fn(),
    getStatefulset: vi.fn(),
    getDaemonset: vi.fn(),
    getDeploymentPods: vi.fn(),
    getReplicaset: vi.fn(),
    getDeploymentReplicasets: vi.fn(),
    streamPodLogs: vi.fn(),
    stopLogStream: vi.fn(),
    logStreamSubscribed: vi.fn(),
    getPodLogs: vi.fn(),
    getClusterInfo: vi.fn(),
    getEndpoints: vi.fn(),
    deletePod: vi.fn(),
    restartPod: vi.fn(),
    restartDeployment: vi.fn(),
    getCustomResource: vi.fn(),
    getCustomResourceYaml: vi.fn(),
    getService: vi.fn(),
    getResourceConnections: vi.fn(),
    getNamespace: vi.fn(),
    getGatewayRoute: vi.fn(),
    listNodes: vi.fn(),
    listPods: vi.fn(),
    listDeployments: vi.fn(),
    listServices: vi.fn(),
    detectGatewayApi: vi.fn(),
    listBackendTlsPolicies: vi.fn(),
    listApiCatalog: vi.fn(() => new Promise(() => {})),
    listRoleBindingsIn: vi.fn(() => new Promise(() => {})),
    listClusterRoleBindings: vi.fn(() => new Promise(() => {})),
  },
}));

const REPLICASET_MANIFEST = `apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: promo-abc
  labels:
    tier: control
status:
  phase: Active
`;

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { ROLE_TEXT } from "@/lib/status-role";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import { useWindowActivity } from "@/lib/window-activity";
import { renderWithRouter } from "@/test/render";
import { usePeek, type PeekTarget } from "@/hooks/usePeek";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import {
  PEEK_WIDTH_DEFAULT,
  useDisplaySettingsStore,
} from "@/stores/displaySettingsStore";
import { PeekPanel } from "./PeekPanel";
import { Toaster } from "@/components/ui/toaster";
import { forgetLastOwners } from "@/hooks/useLastOwners";
import { ResourceRef } from "@/components/object/ResourceRef";
import { preloadPeekContent } from "./peek-loader";
import { pageTab } from "@/hooks/usePeek";

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

function buildReplicaSet(
  overrides: Partial<ReplicaSetInfo> = {}
): ReplicaSetInfo {
  return {
    name: "crash-demo-56588f6b8c",
    namespace: "k8s-gui-test",
    uid: "rs-uid",
    replicas: { desired: 1, current: 1, ready: 0, available: 0 },
    revision: null,
    currentRevision: null,
    ownerReferences: [],
    ...overrides,
  } as ReplicaSetInfo;
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
    generation: null,
    fields: {},
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
    namespace: "storefront",
    uid: "svc-uid",
    type: "ClusterIP",
    sessionAffinity: "None",
    clusterIp: "10.10.19.25",
    externalName: null,
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
    namespace: "storefront",
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
    subject: objRef("Service", "frontend", "storefront"),
    edges,
    stops: [],
    published: [],
    notLookedAt: [],
  };
}

function Probe() {
  const { pathname, searchStr } = useLocation();
  return <span data-testid="location">{`${pathname}${searchStr}`}</span>;
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

const openTab = (name: string | RegExp) =>
  userEvent.click(screen.getByRole("tab", { name }));

const wrap = (entry: string, ui: ReactNode = <PeekPanel />) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  wrap.client = client;
  return renderWithRouter(
    <>
      {ui}
      <Probe />
    </>,
    { client, at: entry, route: "/c/$cluster/$" }
  );
};

wrap.client = null as unknown as QueryClient;

const location = () => screen.getByTestId("location").textContent;
const POD_PEEK =
  "/c/prod/events?peek=pods/k8s-gui-test/crash-demo-56588f6b8c-8bj9v";

function mockCluster() {
  vi.mocked(commands.getPod).mockReset().mockResolvedValue(buildPod());
  vi.mocked(commands.getReplicaset)
    .mockReset()
    .mockResolvedValue(buildReplicaSet());
  vi.mocked(commands.getDeploymentReplicasets)
    .mockReset()
    .mockResolvedValue([]);
  vi.mocked(commands.getManifest)
    .mockReset()
    .mockResolvedValue(REPLICASET_MANIFEST);
  vi.mocked(commands.getServedObject)
    .mockReset()
    .mockResolvedValue(load(REPLICASET_MANIFEST));
  vi.mocked(commands.getNamespace)
    .mockReset()
    .mockResolvedValue({
      name: "kube-system",
      uid: "uid-kube-system",
      status: "Active",
      labels: { tier: "control" },
      createdAt: null,
    });
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

// The body is fetched ahead of the first peek in the app; here it is fetched
// once, so every render below opens the panel whole, as a click does.
beforeAll(async () => {
  await preloadPeekContent();
});

describe("PeekPanel", () => {
  beforeEach(mockCluster);

  it("stays out of the way when nothing is peeked", async () => {
    await wrap("/c/prod/events");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commands.getPod).not.toHaveBeenCalled();
  });

  // The header comes from the URL, so the panel is never an empty box that
  // fills in and shifts under the reader's eye.
  it("names the object before the fetch resolves", async () => {
    vi.mocked(commands.getPod).mockReturnValue(new Promise(() => {}));
    await wrap(POD_PEEK);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "crash-demo-56588f6b8c-8bj9v"
    );
    expect(screen.getByTestId("peek-skeleton")).toBeInTheDocument();
  });

  /**
   * The panel is named by its title, and the name has to be the object:
   * the kind from `ResourceName`'s hidden span, then the name, and nothing
   * else. A label that leaks in from a control beside it is the identity
   * said twice with a verb in the middle.
   *
   * What this does *not* catch: re-nesting `CopyName` inside `SheetTitle`.
   * Checked by moving it — the computed name is byte-identical either way
   * here, so the arrangement the comment in PeekPanel.tsx defends is not
   * observable in this environment and is not guarded by anything.
   */
  it("announces itself as the object and nothing else", async () => {
    vi.mocked(commands.getPod).mockReturnValue(new Promise(() => {}));
    await wrap(POD_PEEK);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Pod crash-demo-56588f6b8c-8bj9v"
    );
  });

  /** The badge says what the kubelet last wrote. Once that kubelet stops
   *  answering, the word is a memory: the pods list and the pod page both
   *  drop the colour for it, and this panel drew the same pod confident
   *  green beside them. */
  it("does not paint a pod green when its node stopped reporting", async () => {
    vi.mocked(commands.listNodes).mockResolvedValue([
      {
        name: "k3d-agent-0",
        status: {
          conditions: [
            {
              type: "Ready",
              status: "Unknown",
              reason: "NodeStatusUnknown",
              message: "Kubelet stopped posting node status.",
              lastTransitionTime: "2026-08-31T00:00:00Z",
            },
          ],
        },
      },
    ] as unknown as Awaited<ReturnType<typeof commands.listNodes>>);

    await wrap(POD_PEEK);
    const badge = await screen.findByText("CrashLoopBackOff");

    // The node list arrives after the pod, so the badge starts confident and
    // has to give the colour up once the silence is known.
    await waitFor(() =>
      expect(badge.className).not.toMatch(/text-err|text-ok/)
    );
  });

  /**
   * The peek and the detail page draw the same object, and the page carried
   * what was firing about it while the peek beside it showed nothing — the
   * reader who peeks at a crashing pod is the one who most wants the alert.
   */
  it("carries what is firing about the peeked object", async () => {
    await wrap(POD_PEEK);
    expect(
      await screen.findByText("alerts about Pod crash-demo-56588f6b8c-8bj9v")
    ).toBeVisible();
  });

  /** The third surface that draws a pod's status, after the list and the page. */
  it("explains the pod's status on its badge, as the list and the page do", async () => {
    await wrap(POD_PEEK);
    const badge = await screen.findByText("CrashLoopBackOff");
    expect(badge.closest("[title]")).toHaveAttribute(
      "title",
      expect.stringMatching(/^CrashLoopBackOff: a container keeps exiting/)
    );
  });

  /**
   * Sam's checkout pod read red Running with the between-crashes sentence on
   * the list, the page and the Logs header, and only the phase's meaning in
   * the peek. Fails if the peek explains the word apart from those three.
   */
  it("says a pod is up between crashes on its badge, as the list and the page do", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(
      buildPod({
        status: {
          phase: "Running",
          display: "Running",
          ready: false,
          conditions: [],
          message: null,
          reason: null,
          loopingExitAt: new Date(Date.now() - 5_000).toISOString(),
        },
      })
    );
    await wrap(POD_PEEK);
    const badge = await within(screen.getByRole("dialog")).findByText(
      "Running",
      { selector: "header span" }
    );
    expect(badge).toHaveClass(ROLE_TEXT.err);
    expect(badge.closest("[title]")?.getAttribute("title")).toMatch(
      /^Running: placed on a node[^\n]*\n(.*\n)?Up between crashes: a container keeps exiting/
    );
  });

  it("shows the summary and this object's events once they arrive", async () => {
    await wrap(POD_PEEK);
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

  /**
   * Sam's node peek said "Recent events 20" where kubectl had 32: the read
   * asked for 20 and the heading called them all. The backend answers at
   * most the limit it is given, as the mock does. Fails if the peek asks
   * for only what it shows again, or prints the shown count as the total.
   */
  it("says how many events the latest twenty are out of", async () => {
    const all = Array.from({ length: 32 }, (_, at) => ({
      ...buildEvent(),
      name: `crash-demo.${at}`,
      uid: `event-${at}`,
    }));
    vi.mocked(commands.listEvents).mockImplementation(async (filters) =>
      all.slice(0, filters?.limit ?? all.length)
    );
    await wrap(POD_PEEK);

    expect(await screen.findByText("20 of 32")).toBeInTheDocument();
    expect(screen.getAllByText("BackOff")).toHaveLength(20);
  });

  /**
   * Marco's Service peek said "No events for this object" and nothing about
   * whether events were read. Fails if a refused or failed read reads as
   * none, if the two look alike, or if none forgets to say a read answered.
   */
  it("says the events were refused, failed or read and none, each apart", async () => {
    const refusal = Object.assign(
      new Error('events is forbidden: User "marco" cannot list events'),
      { code: "PERMISSION_DENIED" }
    );
    vi.mocked(commands.listEvents).mockRejectedValue(refusal);
    const refused = await wrap(POD_PEEK);
    const words = await screen.findByText(
      "You do not have permission to read these events."
    );
    expect(words).toHaveAttribute("data-read", "refused");
    expect(screen.queryByText("No events for this object")).toBeNull();
    vi.mocked(commands.listEvents).mockResolvedValue([]);
    await userEvent.click(
      within(screen.getByTestId("events-unread")).getByRole("button", {
        name: "Try the read again",
      })
    );
    expect(
      await screen.findByText("No events for this object")
    ).toBeInTheDocument();
    expect(screen.getByText(/^Read at .*: none yet/)).toBeInTheDocument();
    refused.unmount();

    vi.mocked(commands.listEvents).mockRejectedValue(
      new Error("connection refused")
    );
    await wrap(POD_PEEK);
    expect(await screen.findByText("Could not read events.")).toHaveAttribute(
      "data-read",
      "failed"
    );
    expect(screen.queryByText("No events for this object")).toBeNull();
  });

  /**
   * "268435456" is a manifest's spelling; "256Mi" is an answer. The peek
   * prints whatever unit the author used unless it can say it better.
   */
  it("prints requests and limits in humane units, not raw bytes", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(
      buildPod({
        cpuRequests: "0.5",
        cpuLimits: null,
        memoryRequests: "268435456",
        memoryLimits: "1Gi",
      } as Partial<PodInfo>)
    );
    await wrap(POD_PEEK);
    expect(await screen.findByText("500m → unlimited")).toBeInTheDocument();
    expect(screen.getByText("256Mi → 1Gi")).toBeInTheDocument();
  });

  it("says what failed and keeps offering the full page", async () => {
    vi.mocked(commands.getPod).mockRejectedValue(
      new Error("connection refused")
    );
    await wrap(POD_PEEK);
    expect(await screen.findByText(/connection refused/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open full page/ })
    ).toBeInTheDocument();
  });

  /**
   * During the 502 outage a pod's page kept the pod and the peek beside it
   * replaced the pod with the error. Fails if a failed re-read drops the
   * object the peek was showing, or keeps it with nothing saying it is old.
   */
  it("keeps the object a failed re-read left, said to be from the last read that answered", async () => {
    await wrap(POD_PEEK);
    expect(await screen.findByText("10.42.0.46")).toBeInTheDocument();

    vi.mocked(commands.getPod).mockRejectedValue(new Error("502 Bad Gateway"));
    await act(() => wrap.client.refetchQueries());

    expect(
      await screen.findByText(
        /Could not read Pod crash-demo-56588f6b8c-8bj9v just now/
      )
    ).toBeInTheDocument();
    expect(screen.getByText("10.42.0.46")).toBeInTheDocument();
    expect(screen.getByText(/502 Bad Gateway/)).toBeInTheDocument();
  });

  it("leaves for the full page and closes behind itself", async () => {
    await wrap(POD_PEEK);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open full page/ })
    );
    await waitFor(() =>
      expect(location()).toBe(
        "/c/prod/pods/k8s-gui-test/crash-demo-56588f6b8c-8bj9v"
      )
    );
  });

  /** Issue #178: leaving Logs for the page landed on Overview. Would break if the tab stopped travelling. */
  it("takes the open tab along to the full page", async () => {
    await wrap(POD_PEEK);
    await openTab("Logs");
    await userEvent.click(
      await screen.findByRole("button", { name: /Open full page/ })
    );
    await waitFor(() =>
      expect(location()).toBe(
        "/c/prod/pods/k8s-gui-test/crash-demo-56588f6b8c-8bj9v?tab=logs"
      )
    );
  });

  /**
   * Dana opened a Deployment from an Event and the full page landed on
   * Overview with no note. Fails if a peek opened for an Event forgets it
   * on the way to the page.
   */
  it("opens a peek opened from an Event on the object's Events tab, noting the Event", async () => {
    await wrap(`${POD_PEEK}&peekVia=events/k8s-gui-test/crash-demo.17f3`);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open full page/ })
    );
    await waitFor(() =>
      expect(location()).toBe(
        "/c/prod/pods/k8s-gui-test/crash-demo-56588f6b8c-8bj9v?tab=events&via=events%2Fk8s-gui-test%2Fcrash-demo.17f3"
      )
    );
  });

  // Radix owns Escape; a second listener here would close it twice.
  it("closes on Escape by dropping the parameter", async () => {
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(location()).toBe("/c/prod/events"));
  });

  it("replaces its contents when a reference inside it is clicked", async () => {
    await wrap(POD_PEEK);
    await userEvent.click(
      await screen.findByRole("link", { name: /k3d-agent/ })
    );
    await waitFor(() =>
      expect(location()).toBe("/c/prod/events?peek=nodes%2Fk3d-agent-0")
    );
  });

  it("falls back to the whole object for a kind with no detail command", async () => {
    await wrap("/c/prod/events?peek=replicasets/k8s-gui-test/promo-abc");
    // The badge and the status row both read the phase out of the manifest.
    expect(await screen.findAllByText("Active")).toHaveLength(2);
    expect(commands.getServedObject).toHaveBeenCalledWith(
      "apps",
      "replicasets",
      "promo-abc",
      "k8s-gui-test"
    );
    // The manifest becomes rows, not a wall of YAML.
    expect(screen.getByText("phase")).toBeInTheDocument();
    expect(screen.getByText("tier")).toBeInTheDocument();
    expect(screen.getByText("control")).toBeInTheDocument();
  });

  it("reads a namespace through its own command, labels first", async () => {
    await wrap("/c/prod/events?peek=namespaces/kube-system");
    expect(await screen.findByText("tier")).toBeInTheDocument();
    expect(commands.getNamespace).toHaveBeenCalledWith("kube-system");
    // The labels are the payload: they are what every namespaceSelector —
    // a Gateway listener's allowedRoutes included — matches against.
    expect(screen.getByText("control")).toBeInTheDocument();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(commands.getManifest).not.toHaveBeenCalled();
  });

  /**
   * The namespace's page lists the events of every object in it, and its
   * peek read only those about the Namespace object, almost always none.
   * Fails if the two read different events or the peek does not say whose.
   */
  it("lists a namespace's events of every object, as its page does, and names each object", async () => {
    await wrap("/c/prod/events?peek=namespaces/kube-system");

    expect(
      await screen.findByText("Recent events in this namespace")
    ).toBeInTheDocument();
    expect(commands.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "kube-system",
        involved_object_kind: null,
        involved_object_name: null,
      })
    );
    expect(
      screen.getAllByTestId("resource-ref-name").map((name) => name.textContent)
    ).toContain("Pod/crash-demo-56588f6b8c-8bj9v");
  });
});

const CONFIGMAP_PEEK = "/c/prod/events?peek=configmaps/k8s-gui-test/app-config";

/**
 * The panel asks the same questions the detail pages ask, and keeps each
 * answer where the page keeps it: opening the page after the peek costs
 * nothing, and an action on either reaches the other. Each fails if the
 * panel keys that answer apart from the page again.
 */
describe("PeekPanel reads what the detail pages read", () => {
  beforeEach(mockCluster);

  const POD = ["k8s-gui-test", "crash-demo-56588f6b8c-8bj9v"] as const;

  it("keeps the object itself in the pod page's entry", async () => {
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(wrap.client.getQueryData(queryKeys.detail("Pod", ...POD))).toEqual(
      buildPod()
    );
  });

  it("keeps the manifest in the pod page's entry", async () => {
    vi.mocked(commands.getManifest).mockResolvedValue("kind: Pod\n");
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    await openTab("YAML");
    await screen.findByTestId("yaml-editor");
    expect(wrap.client.getQueryData(queryKeys.manifest("Pod", ...POD))).toBe(
      "kind: Pod\n"
    );
  });

  it("keeps a ConfigMap's values where its page and a pod's env read them", async () => {
    await wrap(CONFIGMAP_PEEK);
    await openTab("Data");
    await screen.findByText("worker_processes 1;");
    expect(
      wrap.client.getQueryData(
        queryKeys.configMapData("k8s-gui-test", "app-config")
      )
    ).toMatchObject({ values: { "nginx.conf": "worker_processes 1;" } });
  });

  it("keeps a Deployment's pods in its page's entry", async () => {
    vi.mocked(commands.getDeployment).mockResolvedValue({
      name: "api",
      namespace: "shop",
      uid: "deploy-uid",
      replicas: { desired: 1, ready: 1, current: 1, updated: 1, available: 1 },
      rollout: { state: "ready" },
      strategy: "RollingUpdate",
      containers: [],
      initContainers: [],
      serviceAccountName: null,
      podResources: { requests: {}, limits: {} },
      labels: {},
      annotations: {},
      templateAnnotations: {},
      generation: 1,
      observedGeneration: 1,
      createdAt: null,
      conditions: [],
      ownerReferences: [],
    } as never);
    vi.mocked(commands.getDeploymentPods).mockResolvedValue([buildPod()]);
    await wrap("/c/prod/events?peek=deployments/shop/api");
    await openTab("Pods");
    await waitFor(() =>
      expect(
        wrap.client.getQueryData(
          queryKeys.ownedPods("Deployment", "shop", "api")
        )
      ).toEqual([buildPod()])
    );
  });

  /** The diagnosis a workload's page leads with; a source's `lead` the panel drops says nothing. */
  it("draws a workload's diagnosis above its rows", async () => {
    vi.mocked(commands.getDeployment).mockResolvedValue({
      name: "search",
      namespace: "shop",
      replicas: { desired: 2, ready: 2, updated: 1, available: 2 },
      rollout: { state: "stalled", message: null, serving: 2 },
      containers: [],
      initContainers: [],
      ownerReferences: [],
      createdAt: null,
    } as never);
    await wrap("/c/prod/events?peek=deployments/shop/search");
    expect(await screen.findByTestId("rollout-summary")).toHaveTextContent(
      "Rollout stalled"
    );
  });

  /**
   * Marco's ledger: the page header and the row under the peek's own header
   * said the pods were not read, and the peek's header badge drew the
   * generic hollow Unavailable with its fault meaning. Fails if a set
   * kind's peek header loses the EyeOff mark, takes a colour, or explains
   * the word without saying the pods were not read.
   */
  it.each([
    ["Deployment", "deployments", commands.getDeployment],
    ["StatefulSet", "statefulsets", commands.getStatefulset],
    ["DaemonSet", "daemonsets", commands.getDaemonset],
  ])(
    "draws a %s whose pods were not read as its page header does",
    async (_kind, path, getter) => {
      vi.mocked(getter).mockResolvedValue({
        name: "ledger",
        namespace: "team-blind",
        replicas: { desired: 1, ready: 0, updated: 1, available: 0 },
        desired: 1,
        ready: 0,
        current: 1,
        upToDate: 1,
        available: 0,
        rollout: {
          state: "podsUnread",
          controller: {
            state: "unavailable",
            reason: "MinimumReplicasUnavailable",
            message: null,
            available: 0,
            desired: 1,
          },
        },
        containers: [],
        initContainers: [],
        ownerReferences: [],
        createdAt: null,
      } as never);
      await wrap(`/c/prod/events?peek=${path}/team-blind/ledger`);
      const header = await within(screen.getByRole("dialog")).findByText(
        "Unavailable",
        { selector: "header span" }
      );
      expect(header).toHaveClass(ROLE_TEXT.neutral);
      expect(header.querySelector("svg")).toHaveClass("lucide-eye-off");
      expect(header.closest("[title]")?.getAttribute("title")).toMatch(
        /^Unavailable by the controller's counts alone: its pods could not be read/
      );
    }
  );
});

describe("PeekPanel tab strip", () => {
  beforeEach(mockCluster);

  // The same rule the detail pages are drawn by: a strip where some tabs
  // carry a glyph and others do not is worse than a strip with none.
  it("gives every tab one glyph, and exactly one, on both kinds", async () => {
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
    }

    cleanup();
    await wrap(CONFIGMAP_PEEK);
    await screen.findByRole("tab", { name: /Data/ });
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
    }
  });

  it("counts what it is already holding, and fetches nothing to do it", async () => {
    await wrap(CONFIGMAP_PEEK);
    const data = await screen.findByRole("tab", { name: /Data/ });
    await waitFor(() => expect(data).toHaveTextContent("Data1"));
    expect(data).toHaveAttribute("title", "Data: 1");
    // The keys came with the summary; the values did not, and are still
    // unread until the tab is opened.
    expect(commands.getConfigmapData).not.toHaveBeenCalled();
  });
});

describe("PeekPanel tabs", () => {
  beforeEach(mockCluster);

  it("offers only the surfaces the kind actually has", async () => {
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(tabNames()).toEqual(["Overview", "Logs", "Containers", "YAML"]);

    cleanup();
    await wrap(CONFIGMAP_PEEK);
    await screen.findByRole("tab", { name: "Data" });
    expect(tabNames()).toEqual(["Overview", "Data", "YAML"]);
  });

  // A peek is opened dozens of times an hour. If every open cost a manifest
  // read and a log stream, the panel would be slower than the page it saves.
  it("fetches nothing but the summary until a tab is opened", async () => {
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(commands.getManifest).not.toHaveBeenCalled();
    expect(commands.streamPodLogs).not.toHaveBeenCalled();

    await openTab("YAML");
    await waitFor(() => expect(commands.getManifest).toHaveBeenCalled());
    expect(commands.streamPodLogs).not.toHaveBeenCalled();
  });

  it("renders the manifest under the YAML tab", async () => {
    vi.mocked(commands.getManifest).mockResolvedValue("kind: Pod\n");
    await wrap(POD_PEEK);
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
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    await openTab("YAML");
    expect(await screen.findByText(/manifest denied/)).toBeInTheDocument();

    vi.mocked(commands.getManifest).mockResolvedValue("kind: Pod\n");
    await userEvent.click(
      screen.getByRole("button", { name: "Try the read again" })
    );
    expect(await screen.findByTestId("yaml-editor")).toBeInTheDocument();
  });

  it("streams a running pod's logs", async () => {
    await wrap(POD_PEEK);
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
            resources: { requests: {}, limits: {} },
            envFrom: [],
          },
        ],
      } as Partial<PodInfo>)
    );
    await wrap("/c/prod/events?peek=pods/k8s-gui-test/unschedulable-demo");
    await screen.findByText("Pending");
    await openTab("Logs");

    expect(
      await screen.findByText(/No container has started/)
    ).toBeInTheDocument();
    expect(screen.getByText(/0\/3 nodes are available/)).toBeInTheDocument();
    expect(commands.streamPodLogs).not.toHaveBeenCalled();
  });

  it("reads a ConfigMap's values only once the Data tab is opened", async () => {
    await wrap(CONFIGMAP_PEEK);
    // The tab's name carries its count once the summary lands: "Data1".
    await screen.findByRole("tab", { name: /^Data/ });
    expect(commands.getConfigmapData).not.toHaveBeenCalled();

    await openTab(/^Data/);
    expect(await screen.findByText("nginx.conf")).toBeInTheDocument();
    expect(await screen.findByText("worker_processes 1;")).toBeInTheDocument();
  });

  it("says what failed on the Data tab and offers a retry", async () => {
    vi.mocked(commands.getConfigmapData).mockRejectedValue(
      new Error("configmaps is forbidden")
    );
    await wrap(CONFIGMAP_PEEK);
    await openTab("Data");
    expect(
      await screen.findByText(/configmaps is forbidden/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try the read again" })
    ).toBeInTheDocument();
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
    "/c/prod/events?peek=applications.argoproj.io/Application/argocd/shop";

  it("reads it through its CRD rather than the core API", async () => {
    await wrap(APP_PEEK);
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
    await wrap(APP_PEEK);
    expect(await screen.findByText("shop")).toBeInTheDocument();
    // Twice by design: the reference announces the kind to a screen reader
    // because it draws it as a glyph, and the line under it prints it.
    expect(screen.getAllByText("Application").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", { name: "Application shop" })
    ).toHaveAttribute("href", "/c/prod/applications.argoproj.io/argocd/shop");
  });

  /**
   * Nothing here knows what Argo is. `status.health.status` is drawn because
   * every scalar under `status` is, not because this file recognises it.
   */
  it("draws the operator's status without understanding it", async () => {
    await wrap(APP_PEEK);
    expect(await screen.findByText("health.status")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
  });

  /** A `Ready` condition is the nearest thing to a universal verdict. */
  it("badges it from a Ready condition where there is no phase", async () => {
    await wrap(APP_PEEK);
    expect(await screen.findByText("Not ready")).toBeInTheDocument();
  });

  it("offers its own page, which for a custom resource is the CRD's", async () => {
    await wrap(APP_PEEK);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open full page/ })
    );
    await waitFor(() =>
      expect(location()).toBe("/c/prod/applications.argoproj.io/argocd/shop")
    );
  });

  it("reads the manifest through the CRD too", async () => {
    await wrap(APP_PEEK);
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

describe("PeekPanel on an object that is gone", () => {
  beforeEach(() => {
    mockCluster();
    forgetLastOwners();
  });

  const notFound = () =>
    Object.assign(
      new Error(
        'Kubernetes API error: ApiError: pods "crash-demo-56588f6b8c-8bj9v" not found: NotFound'
      ),
      { code: "NOT_FOUND" }
    );

  /** Read once, then replaced by a restart: the next read is a 404. */
  async function replacedAfterRead(pod: PodInfo) {
    vi.mocked(commands.getPod).mockResolvedValueOnce(pod);
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    vi.mocked(commands.getPod).mockRejectedValue(notFound());
    await act(() => wrap.client.refetchQueries());
    return screen.findByText("This Pod no longer exists.");
  }

  /**
   * The peek of a pod a restart replaced printed the raw ApiError under a
   * green Running badge it no longer had any right to.
   */
  it("says a replaced pod is gone and names the owner that replaces it", async () => {
    await replacedAfterRead(buildPod());
    const panel = screen.getByRole("dialog");
    expect(within(panel).queryByText("CrashLoopBackOff")).toBeNull();
    expect(within(panel).getByText("gone")).toBeInTheDocument();
    expect(
      within(panel).getByText(/replaces what it loses/)
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: /crash-demo-56588f6b8c$/ })
    ).toHaveAttribute(
      "href",
      "/c/prod/replicasets/k8s-gui-test/crash-demo-56588f6b8c"
    );
    expect(
      within(panel)
        .getByText(/ApiError/)
        .closest("details")
    ).not.toHaveAttribute("open");
    expect(within(panel).queryByRole("button", { name: /^Shell/ })).toBeNull();
  });

  /**
   * Dana's peek of a deleted pod still offered Logs and Containers, two
   * readings of a pod that is not there. Fails if a gone object's peek keeps
   * any tab but the Overview that says it is gone.
   */
  it("offers only the Overview once the pod is gone", async () => {
    await replacedAfterRead(buildPod());
    const panel = screen.getByRole("dialog");
    expect(within(panel).getAllByRole("tab")).toHaveLength(1);
    expect(within(panel).queryByRole("tab", { name: /Logs/ })).toBeNull();
    expect(within(panel).queryByRole("tab", { name: /Containers/ })).toBeNull();
  });

  const underDeployment = (desired: number) =>
    buildReplicaSet({
      replicas: { desired, current: desired, ready: desired, available: 0 },
      revision: "1",
      currentRevision: desired > 0 ? "1" : "2",
      ownerReferences: [
        {
          api_version: "apps/v1",
          kind: "Deployment",
          name: "crash-demo",
          uid: "deploy-uid",
          controller: true,
        },
      ],
    });

  /**
   * Dana restarted cart, then peeked an old pod: it named the old
   * ReplicaSet, scaled to 0, as what "replaces what it loses". After a
   * rollout the Deployment replaces it, through its current ReplicaSet.
   */
  it("names the Deployment and its current ReplicaSet for a pod a rollout replaced", async () => {
    vi.mocked(commands.getReplicaset).mockResolvedValue(underDeployment(0));
    vi.mocked(commands.getDeploymentReplicasets).mockResolvedValue([
      underDeployment(0),
      buildReplicaSet({
        name: "crash-demo-7f9c",
        revision: "2",
        currentRevision: "2",
      }),
    ]);
    await replacedAfterRead(buildPod());
    const notice = await screen.findByText(/What runs now comes from/);
    // Each link also carries its kind in a hidden span, hence the repeats.
    expect(notice).toHaveTextContent(
      /^Deployment (Deployment )?crash-demo owned it through ReplicaSet (ReplicaSet )?crash-demo-56588f6b8c, now scaled to 0\. What runs now comes from ReplicaSet (ReplicaSet )?crash-demo-7f9c\.$/
    );
    expect(notice).not.toHaveTextContent(/replaces what it loses/);
    expect(
      within(notice).getByRole("link", { name: /crash-demo-7f9c$/ })
    ).toHaveAttribute(
      "href",
      "/c/prod/replicasets/k8s-gui-test/crash-demo-7f9c"
    );
    expect(
      within(notice).getByRole("link", { name: /crash-demo$/ })
    ).toHaveAttribute("href", "/c/prod/deployments/k8s-gui-test/crash-demo");
  });

  /** A pod deleted inside the live ReplicaSet: that ReplicaSet does replace it. */
  it("names the live ReplicaSet as the replacement, under its Deployment", async () => {
    vi.mocked(commands.getReplicaset).mockResolvedValue(underDeployment(2));
    await replacedAfterRead(buildPod());
    expect(
      await screen.findByText(/which replaces what it loses/)
    ).toHaveTextContent(
      /^Deployment (Deployment )?crash-demo owned it through ReplicaSet (ReplicaSet )?crash-demo-56588f6b8c, which replaces what it loses/
    );
    expect(commands.getDeploymentReplicasets).not.toHaveBeenCalled();
  });

  /** Not read is not "it replaces it": a refused ReplicaSet claims nothing. */
  it("claims no replacement from a ReplicaSet it could not read", async () => {
    vi.mocked(commands.getReplicaset).mockRejectedValue(
      Object.assign(new Error("forbidden"), { code: "PERMISSION_DENIED" })
    );
    await replacedAfterRead(buildPod());
    expect(await screen.findByText(/owned it\.$/)).toHaveTextContent(
      /^ReplicaSet (ReplicaSet )?crash-demo-56588f6b8c owned it\.$/
    );
    expect(screen.queryByText(/replaces/)).toBeNull();
  });

  /** A bare pod has no controller to bring it back, and saying so is the answer. */
  it("says nothing replaces a gone pod that nothing owned", async () => {
    await replacedAfterRead(buildPod({ ownerReferences: [] }));
    expect(
      screen.getByText("Nothing owned it, so nothing replaces it.")
    ).toBeInTheDocument();
  });

  /**
   * A tab switch drops the whole cache, so the peek in the tab that comes
   * back may first read the pod after it died, and said only that it no
   * longer exists, with no Deployment or ReplicaSet to follow.
   */
  it("names the owner its last read found, though the cache was dropped since", async () => {
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    cleanup();

    vi.mocked(commands.getPod).mockRejectedValue(notFound());
    await wrap(POD_PEEK);

    expect(
      await screen.findByText("This Pod no longer exists.")
    ).toBeInTheDocument();
    expect(await screen.findByText(/owned it/)).toHaveTextContent(
      /^ReplicaSet (ReplicaSet )?crash-demo-56588f6b8c owned it and replaces what it loses/
    );
  });

  /** Never read, its owners are unknown, and an unknown is not "nothing owned it". */
  it("names no owner, and claims none, for a pod gone before the first read", async () => {
    vi.mocked(commands.getPod).mockRejectedValue(notFound());
    await wrap(POD_PEEK);
    expect(
      await screen.findByText("This Pod no longer exists.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Nothing owned it/)).toBeNull();
    expect(screen.queryByText(/owned it/)).toBeNull();
  });
});

describe("PeekPanel on a pod deleted underneath it", () => {
  const notFound = () =>
    Object.assign(
      new Error(
        'Kubernetes API error: ApiError: pods "crash-demo-56588f6b8c-8bj9v" not found: NotFound'
      ),
      { code: "NOT_FOUND" }
    );
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const reads = () => vi.mocked(commands.getPod).mock.calls.length;
  /** Every read the panel makes, of the pod and of everything around it. */
  const asked = () =>
    Object.values(commands).reduce(
      (sum, command) =>
        sum + (vi.isMockFunction(command) ? command.mock.calls.length : 0),
      0
    );

  beforeEach(() => {
    mockCluster();
    vi.useFakeTimers();
    useWindowActivity.setState({
      visible: true,
      focused: true,
      interactionAt: 0,
    });
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    useClusterStore.setState({ currentContext: null, isConnected: false });
  });

  /**
   * The last check read `refetchInterval` off the observer and passed while
   * the deleted pod was read every two seconds with the peek open, then on
   * every focus, every click, the reconnect and the cluster switch after it
   * closed. This counts the reads, in the order Dana caused them.
   */
  it("stops reading a pod at NotFound and reads nothing of it once closed", async () => {
    await wrap(POD_PEEK);
    await advance(0);
    expect(screen.getByText("CrashLoopBackOff")).toBeInTheDocument();

    vi.mocked(commands.getPod).mockRejectedValue(notFound());
    await advance(REFRESH_INTERVALS.resourceDetail);
    expect(screen.getByText("This Pod no longer exists.")).toBeInTheDocument();
    const gone = reads();

    await advance(60_000);
    act(() => useWindowActivity.setState({ interactionAt: Date.now() }));
    await advance(10_000);
    expect(reads()).toBe(gone);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await advance(1_000);
    expect(location()).toBe("/c/prod/events");
    const closed = asked();

    act(() => useWindowActivity.setState({ focused: false }));
    act(() => useWindowActivity.setState({ focused: true }));
    act(() => useWindowActivity.setState({ interactionAt: Date.now() }));
    await advance(10_000);
    act(() => void wrap.client.invalidateQueries());
    await advance(1_000);
    act(() => {
      useClusterStore.setState({ currentContext: "staging" });
      wrap.client.removeQueries();
    });
    await advance(60_000);
    expect(reads()).toBe(gone);
    expect(asked()).toBe(closed);
  });
});

describe("PeekPanel on a core kind the registry does not hold", () => {
  beforeEach(mockCluster);

  /** The peek reads the kind's status the way its page does: a Lease has none. */
  it("draws no status for a kind discovery says serves none", async () => {
    vi.mocked(commands.listApiCatalog).mockResolvedValue({
      entries: [
        {
          group: "coordination.k8s.io",
          version: "v1",
          kind: "Lease",
          plural: "leases",
          namespaced: true,
          verbs: ["get"],
          shortNames: [],
          hasStatus: false,
        },
      ],
      unread: [],
    });
    vi.mocked(commands.getCustomResource).mockResolvedValue({
      ...buildApplication(),
      name: "node01",
      namespace: "kube-node-lease",
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      spec: { holderIdentity: "node01" },
      status: null,
    });
    useClusterStore.setState({ isConnected: true });
    await wrap(
      "/c/prod/events?peek=leases.coordination.k8s.io/Lease/kube-node-lease/node01"
    );
    expect(await screen.findByText("holderIdentity")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Nothing reported yet")).not.toBeInTheDocument()
    );
    useClusterStore.setState({ isConnected: false });
  });

  /**
   * The Pod page's ServiceAccount link wrote `?peek=` and nothing opened: the
   * parser took only a dotted CRD, and `serviceaccounts` has no dot.
   */
  it("opens the ServiceAccount a Pod page names, read by its bare plural", async () => {
    vi.mocked(commands.getCustomResource).mockResolvedValue({
      ...buildApplication(),
      name: "marco",
      namespace: "checkout",
      apiVersion: "v1",
      kind: "ServiceAccount",
      spec: null,
      status: null,
      labels: {},
    });
    await wrap(
      "/c/prod/pods/checkout/api-1",
      <>
        <ResourceRef
          kind="ServiceAccount"
          name="marco"
          namespace="checkout"
          showKind={false}
        />
        <PeekPanel />
      </>
    );
    await userEvent.click(screen.getByRole("link", { name: /marco/ }));
    const panel = await screen.findByRole("dialog");
    expect(
      within(panel).getByRole("link", { name: "ServiceAccount marco" })
    ).toHaveAttribute("href", "/c/prod/serviceaccounts/checkout/marco");
    await waitFor(() =>
      expect(commands.getCustomResource).toHaveBeenCalledWith(
        "serviceaccounts",
        "marco",
        "checkout"
      )
    );
    expect(
      await within(panel).findByRole("heading", { name: /What it may do/ })
    ).toBeInTheDocument();
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

  it("falls back to Overview when the next target has no such tab", async () => {
    await wrap(POD_PEEK, withOpeners);
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
    await wrap(POD_PEEK, withOpeners);
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
      resources: { requests: {}, limits: {} },
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
      resources: { requests: {}, limits: {} },
      envFrom: [],
    },
  ],
} as Partial<PodInfo>);

const RUNNING_PEEK = "/c/prod/events?peek=pods/k8s-gui-test/log-demo-1";
const RUNNING_PEEK_LOCATION =
  "/c/prod/events?peek=pods%2Fk8s-gui-test%2Flog-demo-1";

const openMore = () =>
  userEvent.click(screen.getByRole("button", { name: /More actions/ }));

describe("PeekPanel actions", () => {
  beforeEach(mockCluster);

  it("offers a pod's work up front and its destructive end behind a menu", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    await wrap(RUNNING_PEEK);
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
    await wrap("/c/prod/events?peek=pods/k8s-gui-test/unschedulable-demo");
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
    await wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await userEvent.click(screen.getByRole("button", { name: /^Shell/ }));
    await waitFor(() =>
      expect(location()).toBe("/c/prod/pods/k8s-gui-test/log-demo-1?shell=app")
    );
  });

  it("names the object and the consequence before deleting it", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    await wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));

    expect(
      await screen.findByText("Delete Pod k8s-gui-test/log-demo-1?")
    ).toBeInTheDocument();
    expect(screen.getByText(/will start a replacement/)).toBeInTheDocument();

    // Cancelling leaves both the object and the panel exactly where they were.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(commands.deletePod).not.toHaveBeenCalled();
    expect(location()).toBe(RUNNING_PEEK_LOCATION);
  });

  // A peek onto an object that no longer exists is a ghost.
  it("closes itself once the object it is showing is gone", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    vi.mocked(commands.deletePod).mockResolvedValue(undefined);
    await wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    await userEvent.type(
      await screen.findByLabelText(/to confirm/),
      "log-demo-1"
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(location()).toBe("/c/prod/events"));
    expect(commands.deletePod).toHaveBeenCalledWith(
      "log-demo-1",
      "k8s-gui-test",
      false
    );
  });

  /**
   * Dana's Restart deleted the pod on one click while the Deployment's own
   * Restart asked first. A pod's restart is its deletion and asks like one.
   */
  it("asks before restarting an owned pod, with what replaces it", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    await wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Restart/ }));

    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Restart Pod k8s-gui-test/log-demo-1?")
    ).toBeInTheDocument();
    expect(
      within(confirm).getByText(
        /ReplicaSet crash-demo-56588f6b8c will start a replacement/
      )
    ).toBeInTheDocument();
    expect(within(confirm).getByTestId("confirm-details")).toBeInTheDocument();
    expect(
      within(confirm).getByRole("button", { name: "Restart" })
    ).toBeDisabled();
    expect(commands.restartPod).not.toHaveBeenCalled();
  });

  it("keeps the panel open across a restart", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    vi.mocked(commands.restartPod).mockResolvedValue(undefined);
    await wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Restart/ }));
    await userEvent.type(
      await screen.findByLabelText(/to confirm/),
      "log-demo-1"
    );
    await userEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() =>
      expect(commands.restartPod).toHaveBeenCalledWith(
        "log-demo-1",
        "k8s-gui-test"
      )
    );
    expect(location()).toBe(RUNNING_PEEK_LOCATION);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  // Restarting a pod nothing owns is a deletion; it has to be confirmed, and
  // it must not read like a Deployment's rolling restart.
  it("gates a bare pod's restart behind the same confirmation a delete gets", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(
      buildPod({ ...RUNNING_POD, ownerReferences: [] } as Partial<PodInfo>)
    );
    await wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Restart \(deletes it\)/ })
    );
    expect(
      await screen.findByText(/nothing will bring it back/)
    ).toBeInTheDocument();
    expect(commands.restartPod).not.toHaveBeenCalled();
  });

  /**
   * Dana restarted `cart` from the peek by accident: one click must restart
   * nothing, and the Restart button held focus, so a stray Enter did. Fails
   * if Cancel is not focused on opening or Enter restarts.
   */
  it("asks before a Deployment's rolling restart, with the cursor on Cancel", async () => {
    vi.mocked(commands.getDeployment).mockResolvedValue({
      name: "cart",
      namespace: "shop",
      replicas: { desired: 3, ready: 3, updated: 3, available: 3 },
      rollout: { state: "ready" },
      rolloutPlan: {
        strategy: "rolling",
        replicas: 3,
        surge: 1,
        unavailable: 1,
      },
      containers: [],
      initContainers: [],
      ownerReferences: [],
      createdAt: null,
    } as never);
    vi.mocked(commands.restartDeployment).mockReset().mockResolvedValue();
    await wrap("/c/prod/events?peek=deployments/shop/cart");
    await userEvent.click(
      await screen.findByRole("button", { name: /Restart/ })
    );
    expect(await screen.findByTestId("restart-plan")).toHaveTextContent(
      "Replaces 3 pods: at most 1 unavailable and 1 extra at a time."
    );
    expect(commands.restartDeployment).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("restart-plan").closest("form")!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      within(confirm).getByRole("button", { name: "Cancel" })
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByTestId("restart-plan")).toBeNull()
    );
    expect(commands.restartDeployment).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Restart/ }));
    await userEvent.click(
      within(
        (await screen.findByTestId("restart-plan")).closest("form")!
      ).getByRole("button", { name: "Restart" })
    );
    await waitFor(() =>
      expect(commands.restartDeployment).toHaveBeenCalledWith("cart", "shop")
    );
  });

  /**
   * Lena restarted hello-web from the peek and nothing said it had landed,
   * while the page's Restart says "Deployment restarted". Fails unless the
   * peek confirms in the page's words.
   */
  it("confirms a restart the way the page does", async () => {
    vi.mocked(commands.getDeployment).mockResolvedValue({
      name: "hello-web",
      namespace: "lena-sandbox",
      generation: 2,
      replicas: { desired: 1, ready: 1, updated: 1, available: 1 },
      rollout: { state: "ready" },
      rolloutPlan: {
        strategy: "rolling",
        replicas: 1,
        surge: 1,
        unavailable: 0,
      },
      containers: [],
      initContainers: [],
      ownerReferences: [],
      createdAt: null,
    } as never);
    vi.mocked(commands.restartDeployment).mockReset().mockResolvedValue();
    await wrap(
      "/c/prod/events?peek=deployments/lena-sandbox/hello-web",
      <>
        <PeekPanel />
        <Toaster />
      </>
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /Restart/ })
    );
    await userEvent.click(
      within(
        (await screen.findByTestId("restart-plan")).closest("form")!
      ).getByRole("button", { name: "Restart" })
    );
    expect(await screen.findByText("Deployment restarted")).toBeInTheDocument();
    expect(
      screen.getByText("Deployment hello-web is being restarted.")
    ).toBeInTheDocument();
  });

  it("gives a ConfigMap the one action it has", async () => {
    await wrap(CONFIGMAP_PEEK);
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
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(panelWidth()).toBe("620px");
  });

  it("is resizable from the keyboard, not only by dragging", async () => {
    await wrap(POD_PEEK);
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
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
    expect(handle()).toHaveAttribute("aria-valuenow", `${PEEK_WIDTH_DEFAULT}`);
    expect(handle()).toHaveAttribute("aria-valuemin", "360");
  });

  // jsdom reports a 1024px window; the panel has to leave the list behind it
  // something to be.
  it("never grows past what the window can spare", async () => {
    useDisplaySettingsStore.setState({ peekWidth: 1200 });
    await wrap(POD_PEEK);
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

  const SERVICE_PEEK = "/c/prod/events?peek=services/storefront/frontend";

  /** Passes when `above` sits earlier in the document than `below`. */
  const expectAbove = (above: Element, below: Element) =>
    expect(
      above.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

  it("hangs a Service between its way in and its addresses", async () => {
    vi.mocked(commands.getResourceConnections).mockResolvedValue(
      buildConnections([
        {
          from: objRef("Ingress", "frontend-ing", "storefront"),
          to: objRef("Service", "frontend", "storefront"),
          relation: {
            verb: "routes",
            host: "storefront.example.com",
            path: "/",
            pathType: "Prefix",
            port: "3000",
            tls: true,
          },
        },
      ])
    );
    await wrap(SERVICE_PEEK);

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
    // The rule's host rides on the hop, so it says which door this is.
    expect(screen.getByText("storefront.example.com")).toBeInTheDocument();
    // The words the chain replaced stay gone.
    expect(screen.queryByText("Reached through")).toBeNull();
    expect(screen.queryByText("Behind it")).toBeNull();
  });

  it("walks the whole Gateway API way in: Gateway, route, Service, addresses", async () => {
    vi.mocked(commands.getResourceConnections).mockResolvedValue(
      buildConnections([
        {
          from: objRef("HTTPRoute", "frontend-route", "storefront"),
          to: objRef("Service", "frontend", "storefront"),
          relation: {
            verb: "ruleRoutes",
            hostnames: ["shop.example.com"],
            port: "3000",
            weight: null,
          },
        },
        {
          from: objRef("HTTPRoute", "frontend-route", "storefront"),
          to: {
            ...objRef("Gateway", "edge", "infra"),
            facts: { kind: "gateway", className: "envoy" },
          },
          relation: { verb: "attachesTo", sectionName: "http" },
        },
      ])
    );
    await wrap(SERVICE_PEEK);

    expect(await screen.findByText("Traffic path")).toBeInTheDocument();
    const gateway = await screen.findByRole("link", { name: "Gateway edge" });
    const route = screen.getByRole("link", {
      name: "HTTPRoute frontend-route",
    });
    const self = screen.getByText(/this Service/);
    // The path runs from its true beginning: Gateway above route above Service.
    expectAbove(gateway, route);
    expectAbove(route, self);
    // The route's hostnames ride on the hop, and the class rides the Gateway.
    expect(screen.getByText("shop.example.com")).toBeInTheDocument();
    expect(screen.getByText(/class envoy/)).toBeInTheDocument();
  });

  it("reads a route peek in the route's own words, not dotted paths", async () => {
    vi.mocked(commands.getGatewayRoute).mockResolvedValue({
      kind: "HTTPRoute",
      apiVersion: "gateway.networking.k8s.io/v1",
      name: "promo",
      namespace: "storefront",
      hostnames: ["promo.example.com"],
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: "edge",
          namespace: null,
          sectionName: "http",
          port: null,
        },
      ],
      rules: [
        {
          matches: [],
          backendRefs: [
            {
              group: "",
              kind: "Service",
              name: "frontend",
              namespace: null,
              port: 3000,
              weight: null,
            },
          ],
          hasRedirect: false,
          extensionRefs: [],
        },
      ],
      parents: [
        {
          parent: {
            group: "gateway.networking.k8s.io",
            kind: "Gateway",
            name: "edge",
            namespace: null,
            sectionName: null,
            port: null,
          },
          controllerName: "example.net/gw",
          conditions: [
            {
              type: "Accepted",
              status: "True",
              reason: "Accepted",
              message: null,
              lastTransitionTime: null,
            },
          ],
        },
      ],
      generation: 1,
      labels: {},
      annotations: {},
      createdAt: "2026-08-19T20:00:00Z",
    });
    await wrap("/c/prod/events?peek=httproutes/storefront/promo");

    expect(
      await screen.findByRole("link", { name: "Gateway edge" })
    ).toBeInTheDocument();
    expect(commands.getGatewayRoute).toHaveBeenCalledWith(
      "HTTPRoute",
      "promo",
      "storefront"
    );
    expect(screen.getByText("promo.example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Service frontend" })
    ).toBeInTheDocument();
    // The port is a forward, and the flatten's dotted paths are gone.
    expect(screen.getByRole("button", { name: ":3000" })).toBeInTheDocument();
    expect(screen.queryByText(/backendRefs\.0/)).toBeNull();
    expect(commands.getManifest).not.toHaveBeenCalled();
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
    await wrap(POD_PEEK);

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
    await wrap(POD_PEEK);

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

  /**
   * Two routes to one Service are two doors on one level, not two levels:
   * drawn as a sequence they read as admin.example.com flowing INTO
   * example.com. One dot per level; the arrows run between levels only.
   */
  it("stacks parallel ways in at one level rather than chaining them", async () => {
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
                    host: "admin.example.com",
                    path: "/",
                    tls: true,
                    source: {
                      kind: "IngressRoute",
                      name: "crash-admin",
                      namespace: "k8s-gui-test",
                      crd: "ingressroutes.traefik.io",
                    },
                  },
                  {
                    host: "example.com",
                    path: "/",
                    tls: true,
                    source: {
                      kind: "IngressRoute",
                      name: "crash-front",
                      namespace: "k8s-gui-test",
                      crd: "ingressroutes.traefik.io",
                    },
                  },
                ],
              ],
            ]),
          }
    );
    await wrap(POD_PEEK);

    await screen.findByRole("link", { name: "IngressRoute crash-admin" });
    expect(
      screen.getByRole("link", { name: "IngressRoute crash-front" })
    ).toBeInTheDocument();
    // Three levels — the doors, the Service, this Pod — so two arrows,
    // however many doors there are.
  });

  it("names the Service an Endpoints publishes for, above it", async () => {
    await wrap("/c/prod/events?peek=endpoints/storefront/frontend");

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
    await wrap(POD_PEEK);
    await screen.findByText("CrashLoopBackOff");
    expect(screen.queryByText("Traffic path")).toBeNull();
  });
});

describe("restarting a managed workload from the peek on critical infrastructure", () => {
  const PROD = "prod-eu-1";

  beforeEach(() => {
    mockCluster();
    useClusterIdentityStore.setState({ marks: {} });
    useClusterStore.setState({ currentContext: PROD, isConnected: true });
    useClusterIdentityStore.getState().setCritical(PROD, true);
  });

  afterEach(() => {
    useClusterIdentityStore.setState({ marks: {} });
    useClusterStore.setState({ currentContext: null, isConnected: false });
  });

  /**
   * A managed restart is reversible and fires on one click everywhere else,
   * which is exactly why it was the last change on the marked cluster that
   * still had no gate. Here it takes the cluster's name like the rest.
   */
  it("holds the restart until the cluster's name is typed", async () => {
    vi.mocked(commands.getPod).mockResolvedValue(RUNNING_POD);
    await wrap(RUNNING_PEEK);
    await screen.findByText("Running");

    await openMore();
    await userEvent.click(screen.getByRole("menuitem", { name: /Restart/ }));

    // Not fired on the click: the peek's one-click restart is what the gate closes.
    expect(commands.restartPod).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByRole("alert")).toHaveTextContent(PROD);
    const button = within(confirm).getByRole("button", { name: /^Restart$/ });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(PROD), PROD);
    expect(button).toBeEnabled();

    await userEvent.click(button);
    await waitFor(() =>
      expect(commands.restartPod).toHaveBeenCalledWith(
        "log-demo-1",
        "k8s-gui-test"
      )
    );
  });
});

/**
 * The half of "carry the tab along" that the `logs` case cannot see: both
 * sides spell `logs` the same, so a test on a Pod passes whatever the
 * mapping does. The peek has one `children` tab for a workload's pods and a
 * CronJob's jobs, and each page names that tab after the kind it lists — so
 * `?tab=children` matched nothing, the page opened on Overview, and the
 * address kept a parameter the scope tab then recorded as its route.
 */
describe("the peek tab as the detail page spells it", () => {
  it("names a workload's children after the kind that page lists", () => {
    expect(pageTab("children", "Deployment")).toBe("pods");
    expect(pageTab("children", "StatefulSet")).toBe("pods");
    expect(pageTab("children", "CronJob")).toBe("jobs");
  });

  it("passes through the tabs both sides spell alike", () => {
    for (const tab of ["logs", "containers", "connections", "yaml", "data"])
      expect(pageTab(tab, "Pod")).toBe(tab);
  });

  /** Overview is where a page opens anyway; saying so in the URL is noise. */
  it("says nothing for the tab a page opens on", () => {
    expect(pageTab("overview", "Pod")).toBeNull();
  });
});

describe("a peek block whose read was refused", () => {
  const FORBIDDEN = "forbidden: cannot list resource";

  beforeEach(mockCluster);
  afterEach(() => {
    useClusterStore.setState({ currentContext: null, isConnected: false });
  });

  /** A refused neighbourhood read was the same silence as a pod nothing routes. */
  it("says so where nothing routes a pod only because nobody could look", async () => {
    vi.mocked(commands.getResourceConnections).mockRejectedValue(
      new Error(FORBIDDEN)
    );
    await wrap(POD_PEEK);

    expect(await screen.findByText("Traffic path")).toBeInTheDocument();
    expect(
      screen.getByText(`Could not read what connects to this: ${FORBIDDEN}`)
    ).toBeInTheDocument();
  });

  /** "reading…" forever beside a refused list, and "none" beside a read one. */
  it("tells a refused count in a namespace from an empty one", async () => {
    vi.mocked(commands.listPods).mockRejectedValue(new Error(FORBIDDEN));
    vi.mocked(commands.listDeployments).mockResolvedValue([]);
    vi.mocked(commands.listServices).mockResolvedValue([]);
    await wrap("/c/prod/events?peek=namespaces/kube-system");

    expect(await screen.findByText(FORBIDDEN)).toBeInTheDocument();
    expect(screen.getByText("could not read")).toBeInTheDocument();
    expect(screen.getAllByText("none")).toHaveLength(2);
  });

  /** An empty list is "no policy names this Service"; a refused one is not. */
  it("does not drop the policies block when the policies were refused", async () => {
    useClusterStore.setState({ currentContext: "kind", isConnected: true });
    vi.mocked(commands.detectGatewayApi).mockResolvedValue({
      kinds: [{ kind: "BackendTLSPolicy" }],
    } as unknown as Awaited<ReturnType<typeof commands.detectGatewayApi>>);
    vi.mocked(commands.listBackendTlsPolicies).mockRejectedValue(
      new Error(FORBIDDEN)
    );
    await wrap("/c/prod/events?peek=services/storefront/frontend");

    expect(
      await screen.findByText(/Could not read BackendTLSPolicies/)
    ).toBeInTheDocument();
  });

  /**
   * A vendor that did not answer "which of your routes reach this" left the
   * Service drawn as the top of the chain, the same as nothing routing it.
   */
  it("says the integrations could not be asked, rather than that nothing routes it", async () => {
    servicesRoutesSpy.mockReturnValue({
      available: true,
      routes: new Map(),
      isPending: false,
      error: new Error("ingressroutes.traefik.io is forbidden"),
    });
    await wrap("/c/prod/events?peek=services/storefront/frontend");

    expect(
      await screen.findByText(/Could not ask the integrations/)
    ).toBeInTheDocument();
    expect(
      screen.getByText("ingressroutes.traefik.io is forbidden")
    ).toBeInTheDocument();
  });
});

/**
 * Open full page on an EndpointSlice, Endpoints or Lease peek landed on the
 * Service or Node it belongs to. The reader asked for the object itself.
 */
describe("PeekPanel on an object that belongs to a parent", () => {
  beforeEach(mockCluster);

  const openFullPage = async () =>
    userEvent.click(
      await screen.findByRole("button", { name: /Open full page/ })
    );

  it("opens an EndpointSlice on its own page, not its Service's", async () => {
    await wrap(
      "/c/prod/events?peek=endpointslices.discovery.k8s.io/EndpointSlice/kube-system/kube-dns-f2mvh"
    );
    await openFullPage();
    await waitFor(() =>
      expect(location()).toBe(
        "/c/prod/endpointslices.discovery.k8s.io/kube-system/kube-dns-f2mvh?view=own"
      )
    );
  });

  it("opens Endpoints on their own page", async () => {
    await wrap("/c/prod/events?peek=endpoints/kube-system/kube-dns");
    await openFullPage();
    await waitFor(() =>
      expect(location()).toBe("/c/prod/endpoints/kube-system/kube-dns?view=own")
    );
  });

  /** Its title is the same object, so a new tab from it is the same page. */
  it("points its title at the object's own page", async () => {
    await wrap("/c/prod/events?peek=endpoints/kube-system/kube-dns");
    expect(
      await screen.findByRole("link", { name: "Endpoints kube-dns" })
    ).toHaveAttribute(
      "href",
      "/c/prod/endpoints/kube-system/kube-dns?view=own"
    );
  });
});
