import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";

const listEvents = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
  async () => []
);
const listLatestEvents = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  async () => ({ events: [], short: false })
);
const getResourceConnections = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  async () => null
);
const listNodes = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
  async () => []
);
const getDeploymentReplicasets = vi.fn<
  (...args: unknown[]) => Promise<unknown[]>
>(async () => []);
vi.mock("@/lib/commands", () => ({
  commands: {
    getAppInfo: vi.fn(async () => ({ version: "4.20.1" })),
    listEvents: (...args: unknown[]) => listEvents(...args),
    listLatestEvents: (...args: unknown[]) => listLatestEvents(...args),
    getResourceConnections: (...args: unknown[]) =>
      getResourceConnections(...args),
    listNodes: (...args: unknown[]) => listNodes(...args),
    getDeploymentReplicasets: (...args: unknown[]) =>
      getDeploymentReplicasets(...args),
  },
}));

const vendorReport = vi.fn();
vi.mock("@/integrations", async (original) => ({
  ...(await original<object>()),
  useCapabilities: (key: string) =>
    key === "object.report" ? [vendorReport] : [],
}));

import {
  ScreenShareProvider,
  useShareCaveat,
} from "@/components/share/screen-share";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { testRouter } from "@/test/render";
import { refOf } from "@/lib/report-parts";
import { useObjectReport } from "./useObjectReport";

const router = testRouter(null, {
  at: "/c/prod-eu/ingressroutes.traefik.io/web/shop",
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <RouterContextProvider router={router}>
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  </RouterContextProvider>
);

const subject = { kind: "IngressRoute", name: "shop", namespace: "web" };
const resource = {
  apiVersion: "traefik.io/v1alpha1",
  spec: { routes: [] },
  status: null,
  conditions: [
    {
      type: "Ready",
      status: "False",
      reason: "BackendMissing",
      message: null,
      lastTransitionTime: null,
    },
  ],
};

const build = (capturing: boolean) =>
  renderHook(() => useObjectReport(subject, resource, undefined, capturing), {
    wrapper,
  });

describe("the report of any object", () => {
  beforeEach(() => {
    listEvents.mockReset();
    listEvents.mockResolvedValue([]);
    getResourceConnections.mockReset();
    getResourceConnections.mockResolvedValue(null);
    listNodes.mockReset();
    listNodes.mockResolvedValue([]);
    vendorReport.mockReset();
    vendorReport.mockReturnValue(null);
    useClusterStore.setState({ currentContext: "prod-eu", isConnected: true });
    useDisplaySettingsStore.setState({ resourceColouring: "full" });
  });

  /** The frame is on every detail page; a Share nobody pressed must read nothing. */
  it("reads nothing and builds nothing until Share is pressed", async () => {
    const { result } = build(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.report).toBeNull();
    expect(listEvents).not.toHaveBeenCalled();
  });

  /** Every kind that keeps conditions gets them, without its page having to ask. */
  it("finds the object's conditions wherever it keeps them", async () => {
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const conditions = result.current.report!.sections.find(
      (section) => section.id === "conditions"
    );
    expect(conditions?.body).toMatchObject({
      type: "conditions",
      rows: [{ type: "Ready", role: "err" }],
    });
  });

  /** A vendor knows its own objects; its sections belong in the report of one. */
  it("asks the vendors about the object, with its group, spec and status", async () => {
    vendorReport.mockReturnValue([
      {
        id: "routes",
        title: "Routes",
        icon: "",
        body: { type: "text", text: "Host(`shop.example.com`)" },
      },
    ]);
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(vendorReport).toHaveBeenCalledWith(
      expect.objectContaining({
        group: "traefik.io",
        kind: "IngressRoute",
        spec: resource.spec,
      }),
      expect.any(Function)
    );
    expect(result.current.report!.sections.map((s) => s.id)).toContain(
      "routes"
    );
  });

  /**
   * Live, capped's report listed no events while its ReplicaSet held the
   * refusal. Fails if a Deployment's report leaves out its ReplicaSets'
   * warnings, draws one without naming the ReplicaSet, or keeps quiet that
   * they could not be read.
   */
  it("carries a Deployment's ReplicaSet warnings, and says where they could not be read", async () => {
    const deployment = { kind: "Deployment", name: "capped", namespace: "web" };
    const refused = {
      name: "capped-6d67.1",
      namespace: "web",
      uid: "event-1",
      type: "Warning",
      reason: "FailedCreate",
      message: "exceeded quota: two-pods",
      source: null,
      involvedObject: {
        kind: "ReplicaSet",
        name: "capped-6d67",
        namespace: "web",
        uid: "rs",
      },
      count: 73,
      firstTimestamp: null,
      lastTimestamp: "2026-10-15T10:00:00Z",
    };
    listEvents.mockImplementation(async (filters) =>
      (filters as { involved_object_kind: string | null })
        .involved_object_kind === "ReplicaSet"
        ? [refused]
        : []
    );
    getDeploymentReplicasets.mockResolvedValue([
      { uid: "rs", name: "capped-6d67" },
    ]);
    const read = renderHook(
      () => useObjectReport(deployment, {}, undefined, true),
      { wrapper }
    );
    await waitFor(() =>
      expect(
        read.result.current.report?.sections.find((s) => s.id === "events")
          ?.body
      ).toMatchObject({
        type: "events",
        rows: [{ reason: "FailedCreate", ref: expect.anything() }],
      })
    );
    read.unmount();

    getDeploymentReplicasets.mockRejectedValue(
      new Error("replicasets.apps is forbidden")
    );
    const unread = renderHook(
      () => useObjectReport(deployment, {}, undefined, true),
      { wrapper }
    );
    await waitFor(() =>
      expect(unread.result.current.report?.notRead.join(" ")).toContain(
        "The warnings on its ReplicaSets could not be read, so a refusal written there is not shown: replicasets.apps is forbidden"
      )
    );
  });

  /**
   * A namespace's shared file listed "the latest" events of a read that had
   * stopped two thousand events in. Fails if the report of a read cut short
   * does not say its events may not be the latest.
   */
  it("says a namespace's events were read short of their end", async () => {
    listLatestEvents.mockResolvedValue({
      short: true,
      events: [
        {
          name: "web.1",
          namespace: "busy",
          uid: "event-1",
          type: "Normal",
          reason: "Started",
          message: null,
          source: null,
          involvedObject: {
            kind: "Pod",
            name: "web",
            namespace: "busy",
            uid: "pod",
          },
          count: 1,
          firstTimestamp: null,
          lastTimestamp: "2026-11-12T10:00:00Z",
        },
      ],
    });
    const namespace = { kind: "Namespace", name: "busy", namespace: "" };
    const { result } = renderHook(
      () => useObjectReport(namespace, {}, undefined, true),
      { wrapper }
    );
    await waitFor(() =>
      expect(result.current.report?.notRead.join(" ")).toContain(
        "The read stopped before the end of this namespace's events"
      )
    );
    listLatestEvents.mockResolvedValue({ events: [], short: false });
  });

  /** A refused events read is a line in "Not read", never an empty list of events. */
  it("says the events could not be read rather than that there are none", async () => {
    listEvents.mockRejectedValue(new Error("events is forbidden"));
    const { result } = build(true);
    await waitFor(() =>
      expect(result.current.report?.notRead.join(" ")).toContain("forbidden")
    );
    const events = result.current.report!.sections.find(
      (section) => section.id === "events"
    );
    expect(events?.unread).toContain("forbidden");
  });

  /**
   * Lena's hello-web HPA page said Events 2, as kubectl does by uid; its
   * Share said 10, counting the events of every earlier HPA of that name.
   * Fails if Share stops reading the object's own uid off what the page read.
   */
  it("counts only the events of the object the page read, as its page does", async () => {
    const about = (uid: string, reason: string) => ({
      name: `${reason}.${uid}`,
      namespace: "lena-sandbox",
      uid: `event-${reason}-${uid}`,
      type: "Warning",
      reason,
      message: null,
      source: null,
      involvedObject: {
        kind: "HorizontalPodAutoscaler",
        name: "hello-web",
        namespace: "lena-sandbox",
        uid,
      },
      count: 1,
      firstTimestamp: null,
      lastTimestamp: null,
    });
    listEvents.mockResolvedValue([
      about("8b3e3d88", "FailedGetResourceMetric"),
      about("8b3e3d88", "FailedComputeMetricsReplicas"),
      about("c20ecc6d", "FailedGetResourceMetric"),
      about("c20ecc6d", "FailedComputeMetricsReplicas"),
      about("c20ecc6d", "SuccessfulRescale"),
    ]);
    const { result } = renderHook(
      () =>
        useObjectReport(
          {
            kind: "HorizontalPodAutoscaler",
            name: "hello-web",
            namespace: "lena-sandbox",
          },
          { metadata: { name: "hello-web", uid: "8b3e3d88" } },
          undefined,
          true
        ),
      { wrapper }
    );
    await waitFor(() =>
      expect(
        result.current.report?.sections.find((s) => s.id === "events")?.count
      ).toBe(2)
    );
  });

  /**
   * A static pod's events carry the hash in its mirror annotation, not its
   * uid. Fails if Share matches them by the uid and reports none beside a
   * page that lists them.
   */
  it("counts a static pod's events, which carry its mirror hash", async () => {
    const about = (uid: string, reason: string) => ({
      name: `${reason}.${uid}`,
      namespace: "kube-system",
      uid: `event-${reason}-${uid}`,
      type: "Warning",
      reason,
      message: null,
      source: null,
      involvedObject: {
        kind: "Pod",
        name: "etcd-cp",
        namespace: "kube-system",
        uid,
      },
      count: 1,
      firstTimestamp: null,
      lastTimestamp: null,
    });
    listEvents.mockResolvedValue([
      about("5f3c0d7e", "Unhealthy"),
      about("5f3c0d7e", "BackOff"),
      about("0ld0ld0l", "Unhealthy"),
    ]);
    const { result } = renderHook(
      () =>
        useObjectReport(
          { kind: "Pod", name: "etcd-cp", namespace: "kube-system" },
          {
            name: "etcd-cp",
            uid: "9f0c2a11",
            annotations: { "kubernetes.io/config.mirror": "5f3c0d7e" },
          },
          undefined,
          true
        ),
      { wrapper }
    );
    await waitFor(() =>
      expect(
        result.current.report?.sections.find((s) => s.id === "events")?.count
      ).toBe(2)
    );
  });

  /** The sender's colouring choice travels with the file rather than being reset to the default. */
  it("carries the sender's resource colouring setting", async () => {
    useDisplaySettingsStore.setState({ resourceColouring: "off" });
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.colouring).toBe("off");
  });

  /** The link lands a colleague with Rubick on the same page. */
  it("links back to the page the report was made on", async () => {
    const { result } = build(true);
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.link).toMatch(
      /^rubick:\/\/open\/c\/prod-eu\/ingressroutes\.traefik\.io\/web\/shop\?/
    );
  });

  /**
   * The expensive read is the neighbourhood graph, polled while the dialog
   * is open; an IngressRoute has no graph, so the case above could not see
   * it read. A pod does.
   */
  it("reads no graph and no nodes for a pod until Share is pressed", async () => {
    renderHook(
      () =>
        useObjectReport(
          { kind: "Pod", name: "web-1", namespace: "shop" },
          { status: {} },
          undefined,
          false
        ),
      { wrapper }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getResourceConnections).not.toHaveBeenCalled();
    expect(listNodes).not.toHaveBeenCalled();
  });

  /**
   * The dialog keys the public-target tick and the published link on the
   * capture stamp. Minted inside the report, it moved on every watch tick
   * and took both away a second after they were given.
   */
  it("keeps one capture stamp while the object's data moves", async () => {
    const { result, rerender } = renderHook(
      ({ object }: { object: unknown }) =>
        useObjectReport(subject, object, undefined, true),
      { wrapper, initialProps: { object: resource as unknown } }
    );
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const first = result.current.report!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    rerender({ object: { ...resource, spec: { routes: [{}] } } });
    await waitFor(() => expect(result.current.report).not.toBe(first));
    expect(result.current.report!.capturedAt).toBe(first.capturedAt);
  });

  /**
   * A section that says in place it could not be read has to be in "Not
   * read" too; the Node report said "Pods tab not opened" above a footer
   * saying everything was read.
   */
  it("says in Not read every section the page could not read", async () => {
    const { result } = renderHook(
      () =>
        useObjectReport(
          subject,
          resource,
          () => ({
            sections: [
              {
                id: "node-pods",
                order: 20,
                title: "Pods on this node",
                icon: "",
                unread: "The Pods tab was not open",
                body: { type: "table", columns: [], rows: [], more: null },
              },
            ],
          }),
          true
        ),
      { wrapper }
    );
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.notRead).toContain(
      "Pods on this node: The Pods tab was not open"
    );
  });

  /**
   * A detail page keeps the object a failed re-read left and says so in a
   * notice; the report took the old status under a new capture time with
   * nothing in Not read. Fails if the page's notices do not reach the file.
   */
  it("says in Not read what the page's own notices say of its read", async () => {
    function Stale({ children }: { children: ReactNode }) {
      useShareCaveat("Could not read IngressRoute shop when this was made");
      return <>{children}</>;
    }
    const { result } = renderHook(
      () => useObjectReport(subject, resource, undefined, true),
      {
        wrapper: ({ children }) =>
          wrapper({
            children: (
              <ScreenShareProvider>
                <Stale>{children}</Stale>
              </ScreenShareProvider>
            ),
          }),
      }
    );
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.notRead).toContain(
      "Could not read IngressRoute shop when this was made"
    );
  });

  /** The page's own part is given what the frame read once Share was pressed. */
  it("hands the page the capture moment and the nodes that stopped reporting", async () => {
    listNodes.mockResolvedValue([
      {
        name: "n2",
        status: { conditions: [{ type: "Ready", status: "Unknown" }] },
      },
    ]);
    const contribute = vi.fn(() => ({}));
    const { result } = renderHook(
      () => useObjectReport(subject, resource, contribute, true),
      { wrapper }
    );
    await waitFor(() =>
      expect(contribute).toHaveBeenLastCalledWith(
        expect.objectContaining({
          silent: expect.objectContaining({ size: 1 }),
          capturedAt: result.current.report?.capturedAt,
        })
      )
    );
  });

  /**
   * Knative makes a core Service named like its own. Fails if the report of
   * the Knative one reads the graph of the core Service of its name.
   */
  it("reads no graph of the built-in a custom resource shares its kind name with", async () => {
    const { result } = renderHook(
      () =>
        useObjectReport(
          {
            kind: "Service",
            name: "frontend",
            namespace: "storefront",
            crd: "services.serving.knative.dev",
          },
          { apiVersion: "serving.knative.dev/v1" },
          undefined,
          true
        ),
      { wrapper }
    );
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(getResourceConnections).not.toHaveBeenCalled();
    expect(
      result.current.report!.sections.filter(
        (s) => s.id === "connections" || s.id === "traffic"
      )
    ).toEqual([]);
    // Nor is it headed with the built-in's glyph and hue.
    const core = refOf({ kind: "Service", name: "frontend", namespace: null });
    expect(result.current.report!.hero.icon).not.toBe(core.icon);
    expect(result.current.report!.hero.hue).not.toBe(core.kindHue);
    expect(result.current.report!.hero.ref?.icon).not.toBe(core.icon);
  });

  /**
   * The journal is of the built-in workloads this app watches. Fails if an
   * OpenKruise StatefulSet's report, or the report of a pod one owns, carries
   * the changes of the built-in StatefulSet of the same name, or if a pod the
   * built-in one owns loses them.
   */
  it("carries the changes of the built-in workload only, never a namesake's", async () => {
    useChangeJournalStore.setState({
      entries: [
        {
          id: "1",
          context: "prod-eu",
          kind: "StatefulSet",
          namespace: "shop",
          name: "web",
          at: Date.now() - 60_000,
          field: "image",
          key: "app",
          from: "web:1",
          to: "web:2",
        },
      ],
      spans: {},
    });
    const changesOf = async (
      subject: Parameters<typeof useObjectReport>[0],
      resource: unknown
    ) => {
      const { result, unmount } = renderHook(
        () => useObjectReport(subject, resource, undefined, true),
        { wrapper }
      );
      await waitFor(() => expect(result.current.report).not.toBeNull());
      const found = result.current.report!.sections.find(
        (section) => section.id === "changes"
      );
      unmount();
      return found?.count ?? null;
    };
    const pod = { kind: "Pod", name: "web-0", namespace: "shop" };
    const ownedBy = (apiVersion: string) => ({
      ownerReferences: [{ apiVersion, kind: "StatefulSet", name: "web" }],
    });
    try {
      expect(
        await changesOf(
          {
            kind: "StatefulSet",
            name: "web",
            namespace: "shop",
            crd: "statefulsets.apps.kruise.io",
          },
          { apiVersion: "apps.kruise.io/v1beta1" }
        )
      ).toBeNull();
      expect(
        await changesOf(pod, ownedBy("apps.kruise.io/v1beta1"))
      ).toBeNull();
      expect(await changesOf(pod, ownedBy("apps/v1"))).toBe(1);
      expect(
        await changesOf(
          { kind: "StatefulSet", name: "web", namespace: "shop" },
          { apiVersion: "apps/v1" }
        )
      ).toBe(1);
    } finally {
      useChangeJournalStore.setState({ entries: [], spans: {} });
    }
  });

  /**
   * A Secret has connections and no path traffic takes to it; its report
   * said no Service selects "these pods", so traffic never reaches it.
   */
  it("draws what connects to a Secret and no traffic path to it", async () => {
    const secret = {
      kind: "Secret",
      name: "db",
      namespace: "shop",
      existence: "present",
      facts: null,
    };
    getResourceConnections.mockResolvedValue({
      subject: secret,
      edges: [],
      stops: [],
      published: [],
      notLookedAt: [],
    });
    const { result } = renderHook(
      () =>
        useObjectReport(
          { kind: "Secret", name: "db", namespace: "shop" },
          {},
          undefined,
          true
        ),
      { wrapper }
    );
    await waitFor(() =>
      expect(
        result.current.report?.sections.some((s) => s.id === "connections")
      ).toBe(true)
    );
    expect(
      result.current.report!.sections.some((s) => s.id === "traffic")
    ).toBe(false);
  });
});
