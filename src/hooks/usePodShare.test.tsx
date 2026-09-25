import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listNodes = vi.fn<(namespace: string | null) => Promise<unknown[]>>(
  async () => []
);
const getPodLogs = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
  async () => [{ raw: "connecting to db", message: "connecting to db" }]
);
vi.mock("@/lib/commands", () => ({
  commands: {
    getAppInfo: vi.fn(async () => ({ version: "4.18.0" })),
    listNodes: (namespace: string | null) => listNodes(namespace),
    getPodLogs: (...args: unknown[]) => getPodLogs(...args),
    listServices: vi.fn(async () => []),
    getEndpoints: vi.fn(async () => null),
  },
}));

import type { PodInfo } from "@/generated/types";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import { logViewKey, offerLogView } from "@/components/logs/shared-view";
import type { StreamedLogLine } from "@/components/logs/types";
import { usePodShare } from "./usePodShare";

const pod = {
  name: "payments-7b6d9c5f4-x8k2p",
  namespace: "shop",
  uid: "u1",
  nodeName: "node-a",
  podIp: "10.244.0.9",
  createdAt: "2026-09-09T10:00:00Z",
  restartCount: 7,
  status: { display: "CrashLoopBackOff", ready: false },
  volumes: [],
  containers: [
    {
      name: "app",
      image: "registry.example/shop/payments:2.14.1",
      ready: false,
      restartCount: 7,
      state: { type: "waiting", reason: "CrashLoopBackOff" },
      lastTerminated: {
        exitCode: 1,
        signal: null,
        reason: "Error",
        startedAt: null,
        finishedAt: null,
      },
    },
  ],
  initContainers: [],
} as unknown as PodInfo;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const build = () =>
  renderHook(() => usePodShare(pod, []), {
    wrapper,
  });

const line = (container: string, raw: string, level: string | null = null) =>
  ({ container, raw, message: raw, timestamp: null, level }) as StreamedLogLine;

const sectionOf = (
  share: ReturnType<ReturnType<typeof build>["result"]["current"]>,
  id: string
) => share.sections?.find((section) => section.id === id);

describe("what the pod page adds to Share", () => {
  beforeEach(() => {
    listNodes.mockResolvedValue([]);
    useHintSettingsStore.setState({ showPanel: true, includeLogLines: true });
  });

  /**
   * `ready` is not the status: a CrashLoopBackOff and a pod still pulling an
   * image are both "not ready", and the file drew them the same amber.
   */
  it("takes the status role from the app's own table", () => {
    const { result } = build();
    const status = result.current().status!;
    expect(status.text).toBe("CrashLoopBackOff");
    expect(status.role).toBe("err");
  });

  /**
   * When the node stopped answering, everything the kubelet wrote is the
   * last thing it said; the page says so beside the status and the file must too.
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
    const { result } = build();
    await waitFor(() => expect(result.current().status!.text).toContain("·"));
    expect(result.current().status!.role).toBe("warn");
  });

  /** The image's tag is what changed between two runs; the file draws it apart from the repository. */
  it("lists each container with its state and its image tag", () => {
    const { result } = build();
    const containers = sectionOf(result.current(), "containers")!;
    expect(containers.body).toMatchObject({
      type: "containers",
      containers: [
        {
          name: "app",
          repository: "registry.example/shop/payments",
          tag: "2.14.1",
          role: "err",
        },
      ],
    });
  });

  /**
   * The reader sat on the Logs tab, pressed Share, and the file said "Log
   * lines 0": only the lines «Most likely» read for a failing pod went in.
   */
  it("hands over the lines the Logs tab is showing, with their levels", () => {
    const withdraw = offerLogView(logViewKey(pod.namespace, pod.name), () => ({
      lines: [
        line("app", "GET /health 200", "info"),
        line("app", "db refused", "error"),
      ],
      previous: false,
    }));
    const { result } = build();
    const logs = sectionOf(result.current(), "logs")!.body;
    withdraw();
    expect(logs).toMatchObject({
      type: "logs",
      absent: null,
      logs: [
        {
          source: `${pod.name}/app`,
          lines: [
            { text: "GET /health 200", level: "info" },
            { text: "db refused", level: "error" },
          ],
        },
      ],
    });
  });

  /** Lines from several containers, interleaved, keep saying whose they are. */
  it("names the container on every line when the tab shows several", () => {
    const withdraw = offerLogView(logViewKey(pod.namespace, pod.name), () => ({
      lines: [line("app", "start"), line("proxy", "listening")],
      previous: false,
    }));
    const { result } = build();
    const logs = sectionOf(result.current(), "logs")!.body;
    withdraw();
    expect(
      logs.type === "logs" && logs.logs[0].lines.map((l) => l.text)
    ).toEqual(["[app] start", "[proxy] listening"]);
  });

  /** An empty log section with no reason reads as "the pod printed nothing". */
  it("says why there are no log lines when neither source has any", () => {
    useHintSettingsStore.setState({ showPanel: false });
    const { result } = build();
    const logs = sectionOf(result.current(), "logs")!.body;
    expect(logs).toMatchObject({ type: "logs", logs: [] });
    expect(logs.type === "logs" && logs.absent).toContain("Logs tab");
  });

  /**
   * Turning «Most likely» off stops the reading behind it, not only the
   * panel: the previous run's logs are the read the setting exists to prevent.
   */
  it("does not read logs when the reader turned the panel off", async () => {
    const on = build();
    await waitFor(() => expect(getPodLogs).toHaveBeenCalled());
    on.unmount();
    getPodLogs.mockClear();

    useHintSettingsStore.setState({ showPanel: false });
    const { result } = build();
    expect(result.current().sections).toBeDefined();
    expect(getPodLogs).not.toHaveBeenCalled();
  });
});
