import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listNodes = vi.fn<(namespace: string | null) => Promise<unknown[]>>(
  async () => []
);
vi.mock("@/lib/commands", () => ({
  commands: {
    getAppInfo: vi.fn(async () => ({ version: "4.18.0" })),
    listNodes: (namespace: string | null) => listNodes(namespace),
    getPodLogs: vi.fn(async () => []),
    listServices: vi.fn(async () => []),
    getEndpoints: vi.fn(async () => null),
    listNetworkPolicies: vi.fn(async () => []),
  },
}));

import type { PodInfo, ResourceConnections } from "@/generated/types";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { usePodReport } from "./usePodReport";

const pod = {
  name: "payments-7b6d9c5f4-x8k2p",
  namespace: "shop",
  uid: "u1",
  nodeName: "node-a",
  podIp: "10.244.0.9",
  status: { display: "CrashLoopBackOff", ready: false },
  containers: [],
  initContainers: [],
} as unknown as PodInfo;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const read = (over: Partial<ResourceConnections> = {}) =>
  ({
    data: {
      subject: { kind: "Pod", name: pod.name, namespace: pod.namespace },
      edges: [],
      stops: [],
      published: [],
      notLookedAt: [],
      ...over,
    },
    error: null,
    isPending: false,
  }) as never;

const build = (connections: unknown) =>
  renderHook(() => usePodReport(pod, [], null, connections as never, "/pods"), {
    wrapper,
  });

describe("the file the reader hands to somebody else", () => {
  beforeEach(() => {
    listNodes.mockResolvedValue([]);
    useClusterStore.setState({ currentContext: "prod-eu" });
    useChangeJournalStore.setState({ entries: [] });
  });

  /**
   * An empty chain and a chain nobody could read are opposite answers. The
   * file printed "Nothing here." for both, with nothing in "Not read", at
   * the moment the page itself says it could not read what connects — so a
   * colleague concluded nothing is wired to this pod.
   */
  it("says the chain could not be read instead of printing an empty one", async () => {
    const { result } = build({
      data: undefined,
      error: new Error("services is forbidden"),
      isPending: false,
    });

    await waitFor(() => expect(result.current.report).not.toBeNull());
    const report = result.current.report!;
    expect(report.chainUnread).not.toBeNull();
    expect(report.chain).toHaveLength(0);
    expect(report.notRead.join(" ")).toContain(report.chainUnread!);
  });

  /**
   * Where the path stops is the sharpest thing the graph knows, and the file
   * listed the edges only — so a Service that publishes no endpoint arrived
   * as an ordinary working hop.
   */
  it("carries the stops, not only the edges", async () => {
    const { result } = build(
      read({
        stops: [
          {
            reason: "selectsNothing",
            service: { kind: "Service", name: "shop-db-rw", namespace: "shop" },
            selector: "app=db",
          },
        ] as never,
      })
    );

    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report!.chain.length).toBeGreaterThan(0);
  });

  /**
   * The journal is global. A session spent watching another cluster made it
   * non-empty, and the hedge that says this app was never watching here
   * disappeared — "What changed: Nothing here." about a cluster it never saw.
   */
  it("still says it was not watching when the journal is another cluster's", async () => {
    useChangeJournalStore.setState({
      entries: [
        {
          at: Date.now(),
          context: "staging-eu",
          namespace: "shop",
          kind: "Deployment",
          name: "payments",
          field: "image",
          key: null,
          from: "a",
          to: "b",
        },
      ] as never,
    });

    const { result } = build(read());
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const changes = result.current.report!.changes;
    expect(changes).toHaveLength(1);
    expect(changes[0].at).toBeNull();
  });

  /**
   * `ready` is not the status: a CrashLoopBackOff and a pod still pulling an
   * image are both "not ready", and the file drew them the same amber.
   */
  it("takes the status tone from the app's own table", async () => {
    const { result } = build(read());
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const status = result.current.report!.facts[0];
    expect(status.value).toContain("CrashLoopBackOff");
    expect(status.tone).toBe("err");
  });

  /**
   * When the node stopped answering, everything the kubelet wrote is the
   * last thing it said. The page says so beside the status; the file said
   * nothing, so a colleague read a stale state as the state now.
   */
  it("says the node went quiet, as the page does", async () => {
    listNodes.mockResolvedValue([
      {
        name: "node-a",
        status: {
          conditions: [
            {
              type: "Ready",
              status: "Unknown",
              reason: "NodeStatusUnknown",
              lastTransitionTime: "2026-09-20T10:00:00Z",
            },
          ],
        },
      },
    ]);

    const { result } = build(read());
    await waitFor(() =>
      expect(result.current.report?.facts[0].value).toContain("·")
    );
    const status = result.current.report!.facts[0];
    // The status is still there; what is added is that nobody has heard from
    // the node since — which is the part the file was missing.
    expect(status.value).toContain("CrashLoopBackOff");
    expect(
      status.value.replace("CrashLoopBackOff", "").trim().length
    ).toBeGreaterThan(3);
  });

  /**
   * The stamp is the identity the dialog keys the public-target
   * acknowledgement and the published link on. Taken inside the memo, every
   * watch tick and every log poll minted a new one, so the tick a second
   * later unticked the box and erased the link.
   */
  it("keeps one capture stamp while the reader is on the same pod", async () => {
    const { result, rerender } = build(read());
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const first = result.current.report!.capturedAt;

    rerender();
    useChangeJournalStore.setState({ entries: [] });
    rerender();

    expect(result.current.report!.capturedAt).toBe(first);
  });
});
