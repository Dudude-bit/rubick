import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactElement } from "react";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type {
  AccessQuery,
  CatalogEntry,
  EventInfo,
  RolloutPlan,
} from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { AnyObject } from "./AnyObject";
import { DeploymentDetail } from "../(workloads)/deployments/-components/DeploymentDetail";
import { StatefulSetDetail } from "../(workloads)/statefulsets/-components/StatefulSetDetail";
import { DaemonSetDetail } from "../(workloads)/daemonsets/-components/DaemonSetDetail";
import { ReplicaSetDetail } from "../(workloads)/replicasets/-components/ReplicaSetDetail";
import { JobDetail } from "../(workloads)/jobs/-components/JobDetail";
import { CronJobDetail } from "../(workloads)/cronjobs/-components/CronJobDetail";
import { NodeDetail } from "../(cluster)/nodes/-components/NodeDetail";
import { NamespaceDetail } from "../(cluster)/namespaces/-components/NamespaceDetail";
import { IngressDetail } from "../(network)/ingresses/-components/IngressDetail";
import { GatewayDetail } from "../(network)/(gateway-api)/gateways/-components/GatewayDetail";
import { GatewayRouteDetail } from "../(network)/(gateway-api)/-components/GatewayRouteDetail";
import { PersistentVolumeClaimDetail } from "../(storage)/persistentvolumeclaims/-components/PersistentVolumeClaimDetail";

const NS = "shop";

const workload = {
  namespace: NS,
  uid: "uid",
  containers: [],
  initContainers: [],
  serviceAccountName: null,
  podResources: { requests: {}, limits: {} },
  replica: {
    cpuRequests: null,
    cpuLimits: null,
    memoryRequests: null,
    memoryLimits: null,
    known: true,
  },
  labels: {},
  annotations: {},
  templateAnnotations: {},
  conditions: [],
  ownerReferences: [],
  generation: 1,
  observedGeneration: 1,
  createdAt: "2026-10-01T00:00:00Z",
  rollout: { state: "ready" },
};

const rolling: RolloutPlan = {
  strategy: "rolling",
  replicas: 2,
  surge: 1,
  unavailable: 0,
};

interface Kind {
  kind: string;
  group: string;
  plural: string;
  name: string;
  namespaced: boolean;
  get: string;
  object: object;
  page: ReactElement;
}

const KINDS: Kind[] = [
  {
    kind: "Deployment",
    group: "apps",
    plural: "deployments",
    name: "web",
    namespaced: true,
    get: "get_deployment",
    object: {
      ...workload,
      name: "web",
      replicas: { desired: 2, ready: 2, available: 2, updated: 2 },
      rolloutPlan: rolling,
      strategy: "RollingUpdate",
    },
    page: <DeploymentDetail />,
  },
  {
    kind: "StatefulSet",
    group: "apps",
    plural: "statefulsets",
    name: "db",
    namespaced: true,
    get: "get_statefulset",
    object: {
      ...workload,
      name: "db",
      replicas: { desired: 2, ready: 2, current: 2, updated: 2 },
      rolloutPlan: {
        strategy: "ordered",
        replicas: 2,
        start: 0,
        partition: 0,
        unavailable: 1,
      },
      serviceName: "db",
      podManagementPolicy: "OrderedReady",
      updateStrategy: "RollingUpdate",
      claimTemplates: [],
      claimsWhenDeleted: null,
    },
    page: <StatefulSetDetail />,
  },
  {
    kind: "DaemonSet",
    group: "apps",
    plural: "daemonsets",
    name: "agent",
    namespaced: true,
    get: "get_daemonset",
    object: {
      ...workload,
      name: "agent",
      desired: 2,
      current: 2,
      ready: 2,
      upToDate: 2,
      available: 2,
      rolloutPlan: rolling,
      updateStrategy: "RollingUpdate",
      selector: "app=agent",
    },
    page: <DaemonSetDetail />,
  },
  {
    kind: "ReplicaSet",
    group: "apps",
    plural: "replicasets",
    name: "web-5d8f",
    namespaced: true,
    get: "get_replicaset",
    object: {
      ...workload,
      name: "web-5d8f",
      replicas: { desired: 2, current: 2, ready: 2, available: 2 },
      revision: "1",
      currentRevision: "1",
      template: null,
    },
    page: <ReplicaSetDetail />,
  },
  {
    kind: "Job",
    group: "batch",
    plural: "jobs",
    name: "migrate",
    namespaced: true,
    get: "get_job",
    object: {
      ...workload,
      name: "migrate",
      completions: 1,
      parallelism: 1,
      backoffLimit: 6,
      activeDeadlineSeconds: null,
      succeeded: 0,
      failed: 1,
      active: 1,
      status: "Running",
      failure: null,
      startTime: "2026-10-01T00:00:00Z",
      completionTime: null,
    },
    page: <JobDetail />,
  },
  {
    kind: "CronJob",
    group: "batch",
    plural: "cronjobs",
    name: "nightly",
    namespaced: true,
    get: "get_cronjob",
    object: {
      ...workload,
      name: "nightly",
      schedule: "0 3 * * *",
      timezone: null,
      suspend: false,
      concurrencyPolicy: "Forbid",
      startingDeadlineSeconds: null,
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 1,
      active: 0,
      lastSchedule: null,
      lastSuccessfulTime: null,
    },
    page: <CronJobDetail />,
  },
  {
    kind: "Node",
    group: "",
    plural: "nodes",
    name: "controlplane",
    namespaced: false,
    get: "get_node",
    object: {
      name: "controlplane",
      uid: "node-uid",
      status: { ready: true, conditions: [], addresses: [] },
      roles: ["control-plane"],
      version: "v1.33.0",
      os: "linux",
      arch: "amd64",
      containerRuntime: "containerd://2.0.0",
      labels: {},
      taints: [],
      unschedulable: false,
      capacity: {
        cpu: "2",
        memory: "4Gi",
        pods: "110",
        ephemeralStorage: null,
      },
      allocatable: {
        cpu: "2",
        memory: "4Gi",
        pods: "110",
        ephemeralStorage: null,
      },
      providerId: null,
      createdAt: "2026-10-01T00:00:00Z",
    },
    page: <NodeDetail />,
  },
];

const BESIDE = {
  labels: {},
  annotations: {},
  createdAt: "2026-10-01T00:00:00Z",
};

/** The kinds whose page had an Events tab of its own read, with a cap and a refusal unlike the peek's. */
const OWN_READ: Kind[] = [
  {
    kind: "Ingress",
    group: "networking.k8s.io",
    plural: "ingresses",
    name: "shop",
    namespaced: true,
    get: "get_ingress",
    object: {
      ...BESIDE,
      name: "shop",
      namespace: NS,
      className: null,
      rules: [],
      defaultBackend: null,
      loadBalancerIps: [],
      tlsHosts: [],
      tlsConfigs: [],
      hasCatchAllTls: false,
    },
    page: <IngressDetail />,
  },
  {
    kind: "Gateway",
    group: "gateway.networking.k8s.io",
    plural: "gateways",
    name: "edge",
    namespaced: true,
    get: "get_gateway",
    object: {
      ...BESIDE,
      name: "edge",
      namespace: NS,
      apiVersion: "gateway.networking.k8s.io/v1",
      className: "cilium",
      listeners: [],
      listenerSets: [],
      listenerSetsKnown: true,
      addresses: [],
      conditions: [],
      generation: 1,
    },
    page: <GatewayDetail />,
  },
  {
    kind: "HTTPRoute",
    group: "gateway.networking.k8s.io",
    plural: "httproutes",
    name: "store",
    namespaced: true,
    get: "get_gateway_route",
    object: {
      ...BESIDE,
      kind: "HTTPRoute",
      apiVersion: "gateway.networking.k8s.io/v1",
      name: "store",
      namespace: NS,
      hostnames: [],
      parentRefs: [],
      rules: [],
      parents: [],
      generation: 1,
    },
    page: <GatewayRouteDetail kind="HTTPRoute" />,
  },
  {
    kind: "PersistentVolumeClaim",
    group: "",
    plural: "persistentvolumeclaims",
    name: "data-db-0",
    namespaced: true,
    get: "get_persistent_volume_claim",
    object: {
      ...BESIDE,
      name: "data-db-0",
      namespace: NS,
      status: "Bound",
      volume: "pvc-1",
      capacity: "1Gi",
      accessModes: ["ReadWriteOnce"],
      storageClass: "standard",
    },
    page: <PersistentVolumeClaimDetail />,
  },
];

const NAMESPACE: Kind = {
  kind: "Namespace",
  group: "",
  plural: "namespaces",
  name: NS,
  namespaced: false,
  get: "get_namespace",
  object: {
    name: NS,
    uid: "ns-uid",
    status: "Active",
    labels: {},
    createdAt: "2026-10-01T00:00:00Z",
  },
  page: <NamespaceDetail />,
};

const entry = (
  group: string,
  plural: string,
  kind: string,
  namespaced: boolean
): CatalogEntry => ({
  group,
  version: "v1",
  kind,
  plural,
  namespaced,
  verbs: ["get", "list", "watch"],
  shortNames: [],
});

const apiVersionOf = (target: Kind) =>
  target.group ? `${target.group}/v1` : "v1";

/** Where the cluster files an event about `target`: its own namespace, or `default` for a cluster-scoped one. */
const eventNamespace = (target: Kind) =>
  target.namespaced || target.kind === "Namespace" ? NS : "default";

const event = (
  about: { kind: string; name: string; namespace: string | null },
  reason: string,
  type: "Normal" | "Warning",
  count: number,
  namespace: string
): EventInfo => ({
  name: `${about.name}.${reason}`,
  namespace,
  uid: `event-${about.kind}-${about.name}-${reason}`,
  type,
  reason,
  message: `${reason} for ${about.name}`,
  source: "controller",
  involvedObject: { ...about, uid: null },
  count,
  firstTimestamp: "2026-10-07T06:00:00Z",
  lastTimestamp: "2026-10-07T06:30:00Z",
});

let listed: Array<Record<string, unknown>> = [];

/**
 * A cluster where `target` exists and `events` answers its events, opened
 * at the address of one of them as an Event's Open does.
 */
async function openEventAbout(
  target: Kind,
  events: () => Promise<EventInfo[]>
) {
  const namespace = eventNamespace(target);
  const own = event(
    {
      kind: target.kind,
      name: target.name,
      namespace: target.namespaced ? NS : null,
    },
    "Opened",
    "Normal",
    1,
    namespace
  );
  vi.mocked(invoke).mockImplementation(async (command: string, args) => {
    const asked = args as Record<string, unknown> | undefined;
    if (command === "list_api_catalog")
      return {
        entries: [
          entry("", "events", "Event", true),
          entry(target.group, target.plural, target.kind, target.namespaced),
        ],
        unread: [],
      };
    if (command === "get_served_object")
      return asked?.plural === "events"
        ? {
            metadata: { name: own.name, namespace },
            involvedObject: {
              apiVersion: apiVersionOf(target),
              kind: target.kind,
              name: target.name,
              namespace: target.namespaced ? NS : undefined,
            },
          }
        : { metadata: { name: target.name } };
    if (command === target.get) return target.object;
    if (command === "list_events") {
      listed.push((asked?.filters ?? {}) as Record<string, unknown>);
      return events();
    }
    if (command === "check_access")
      return (asked as { queries: AccessQuery[] }).queries.map((query) => ({
        ...query,
        allowed: true,
      }));
    if (
      command === "list_service_health_inputs" ||
      (command.startsWith("list_") && command.endsWith("_in"))
    )
      return { rows: [], unread: [] };
    if (command.startsWith("list_") || command.endsWith("_pods")) return [];
    return undefined;
  });
  const page = target.namespaced
    ? `/c/$cluster/${target.plural}/$namespace/$name`
    : `/c/$cluster/${target.plural}/$name`;
  return renderWithRouter(
    <AnyObject resource="events" namespace={namespace} name={own.name} />,
    {
      at: `/c/prod/events/${namespace}/${own.name}`,
      route: "/c/$cluster/$resource/$namespace/$name",
      beside: { [page]: target.page },
    }
  );
}

const selectedTab = () =>
  screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true");

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  listed = [];
  useClusterStore.setState({ currentContext: "prod", isConnected: true });
});

describe.each([...KINDS, ...OWN_READ])(
  "an Event about a $kind, opened",
  (target) => {
    const about = {
      kind: target.kind,
      name: target.name,
      namespace: target.namespaced ? NS : null,
    };
    const KUBECTL = [
      event(about, "BackOff", "Warning", 29, eventNamespace(target)),
      event(about, "Scheduled", "Normal", 1, eventNamespace(target)),
      event(about, "Created", "Normal", 3, eventNamespace(target)),
    ];

    /**
     * Opening an Event about a workload, a node or a Job kept the reader on
     * the Event's bare page, and a link naming tab=events opened Overview,
     * because only the Pod page had the tab. Fails if the event does not land
     * on its object's Events tab with the events its peek reads.
     */
    it("lands on the object's Events tab, listing what the peek reads", async () => {
      const { router } = await openEventAbout(target, async () => KUBECTL);

      await waitFor(() =>
        expect(router.state.location.search).toMatchObject({ tab: "events" })
      );
      expect(router.state.location.pathname).toBe(
        target.namespaced
          ? `/c/prod/${target.plural}/${NS}/${target.name}`
          : `/c/prod/${target.plural}/${target.name}`
      );
      await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Events/));
      expect(selectedTab()).toHaveAttribute("title", "Events: 3");
      for (const reason of ["BackOff", "Scheduled", "Created"])
        expect(await screen.findByText(reason)).toBeInTheDocument();
      expect(screen.getByText("3 events")).toBeInTheDocument();
      expect(listed.at(-1)).toMatchObject({
        involved_object_kind: target.kind,
        involved_object_name: target.name,
        limit: 200,
      });
    });

    /**
     * A refused read drew "No events for this object" on the pages that
     * swallowed it. Fails if the tab or its mark reads a 403 as none.
     */
    it("says it could not read the events where the cluster refused, with a hollow mark", async () => {
      await openEventAbout(target, async () => {
        throw {
          code: "KUBE_API_ERROR",
          message: 'events is forbidden: User "marco" cannot list events',
        };
      });

      expect(
        await screen.findByRole("tab", {
          name: "Events: Could not read events.",
        })
      ).toBeInTheDocument();
      expect(screen.getByText("Could not read events.")).toBeInTheDocument();
      expect(screen.queryByText("No events for this object")).toBeNull();
    });
  }
);

describe("the Events tab of an object with more events than one read holds", () => {
  /**
   * Marco and Lena saw a lone "4" above the rows. Fails if the count stops
   * saying what it counts, or calls 200 rows of a longer list the whole.
   */
  it("says its count is of events, and only the latest where the read stopped", async () => {
    const target = KINDS[0];
    const about = { kind: target.kind, name: target.name, namespace: NS };
    await openEventAbout(target, async () =>
      Array.from({ length: 200 }, (_, index) =>
        event(about, `Pulled${index}`, "Normal", 1, NS)
      )
    );
    expect(
      await screen.findByText("the latest 200 events, more not read")
    ).toBeInTheDocument();
  });
});

describe("an Event about a Namespace, opened", () => {
  const IN_SHOP = [
    event(
      { kind: "Pod", name: "web-1", namespace: NS },
      "BackOff",
      "Warning",
      4,
      NS
    ),
    event(
      { kind: "Deployment", name: "web", namespace: NS },
      "ScalingReplicaSet",
      "Normal",
      1,
      NS
    ),
  ];

  /**
   * The namespace's page is opened for what happens in it, and the events
   * about the Namespace object alone are almost always none. Fails if the
   * tab reads only the Namespace's own events, or does not say whose they are.
   */
  it("lands on the namespace's Events tab with every object's events, named", async () => {
    const { router } = await openEventAbout(NAMESPACE, async () => IN_SHOP);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/c/prod/namespaces/${NS}`)
    );
    await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Events/));
    expect(
      await screen.findByText(
        `The events of every object in ${NS}, not only those about the Namespace itself.`
      )
    ).toBeInTheDocument();
    const panel = screen.getByRole("tabpanel");
    expect(
      within(panel)
        .getAllByTestId("resource-ref-name")
        .map((name) => name.textContent)
    ).toEqual(["Pod/web-1", "Deployment/web"]);
    expect(listed.at(-1)).toMatchObject({
      namespace: NS,
      involved_object_kind: null,
      involved_object_name: null,
    });
  });
});

describe("the Events tab of a claim no provisioner has picked up", () => {
  /**
   * An unbound claim with no events is waiting on a provisioner, which the
   * claim page said before its tab moved onto the shared read. Fails if the
   * tab falls back to the plain "No events" a bound claim gets.
   */
  it("says nobody has picked it up, not only that it has no events", async () => {
    const claim = OWN_READ.find(
      (kind) => kind.kind === "PersistentVolumeClaim"
    )!;
    await openEventAbout(
      {
        ...claim,
        object: { ...claim.object, status: "Pending", volume: null },
      },
      async () => []
    );

    expect(
      await screen.findByText(
        "No events yet: no provisioner has picked this claim up."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("No events for this object")).toBeNull();
  });
});
