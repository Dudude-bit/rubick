import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
import { translate } from "@/i18n";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import { logViewKey, offerLogView } from "@/components/logs/shared-view";
import type { StreamedLogLine } from "@/components/logs/types";
import type { NodeSilence } from "@/lib/node-reporting";
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

const build = (eventsError: unknown = null) =>
  renderHook(() => usePodShare(pod, [], eventsError), {
    wrapper,
  });

const AT = "2026-09-25T12:00:00Z";
const frame = (silent = new Map<string, NodeSilence>()) => ({
  silent,
  capturedAt: AT,
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
    const status = result.current(frame()).status!;
    expect(status.text).toBe("CrashLoopBackOff");
    expect(status.role).toBe("err");
  });

  /**
   * When the node stopped answering, everything the kubelet wrote is the
   * last thing it said. The page drops the badge's colour and says so; the
   * file does the same, with the silence the frame read when Share was
   * pressed.
   */
  it("says the node went quiet and drops the colour, as the page does", () => {
    const { result } = build();
    const status = result.current(
      frame(
        new Map([
          [
            "node-a",
            {
              node: "node-a",
              since: "2026-09-25T11:00:00Z",
              reason: "NodeStatusUnknown",
            },
          ],
        ])
      )
    ).status!;
    expect(status.text).toContain("CrashLoopBackOff · ");
    expect(status.role).toBe("neutral");
  });

  /** The image's tag is what changed between two runs; the file draws it apart from the repository. */
  it("lists each container with its state and its image tag", () => {
    const { result } = build();
    const containers = sectionOf(result.current(frame()), "containers")!;
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
    const logs = sectionOf(result.current(frame()), "logs")!.body;
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
    const logs = sectionOf(result.current(frame()), "logs")!.body;
    withdraw();
    expect(
      logs.type === "logs" && logs.logs[0].lines.map((l) => l.text)
    ).toEqual(["[app] start", "[proxy] listening"]);
  });

  /** An empty log section with no reason reads as "the pod printed nothing". */
  it("says why there are no log lines when neither source has any", () => {
    useHintSettingsStore.setState({ showPanel: false });
    const { result } = build();
    const logs = sectionOf(result.current(frame()), "logs")!.body;
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
    expect(result.current(frame()).sections).toBeDefined();
    expect(getPodLogs).not.toHaveBeenCalled();
  });

  /**
   * Settings › «Copy for agent» and Share include log lines, turned off, is
   * how a reader keeps container output on this machine. The pod report used
   * to honour it, and Share with the Logs tab open took up to 500 lines anyway.
   */
  it("keeps every log line out when the reader turned log lines off", () => {
    useHintSettingsStore.setState({ includeLogLines: false });
    const withdraw = offerLogView(logViewKey(pod.namespace, pod.name), () => ({
      lines: [line("app", "db password=hunter2")],
      previous: false,
    }));
    const { result } = build();
    const logs = sectionOf(result.current(frame()), "logs")!.body;
    withdraw();
    expect(logs).toMatchObject({ type: "logs", logs: [] });
    expect(logs.type === "logs" && logs.absent).toContain("turned off");
  });

  /**
   * «Most likely» reads the pod's events for its verdict. Built from none
   * because the read failed, the verdict has to say what it did not see.
   */
  it("says the verdict was made without the events when they could not be read", () => {
    const { result } = build(new Error("events is forbidden"));
    expect(result.current(frame()).notRead).toContainEqual(
      expect.stringContaining("events is forbidden")
    );
  });
});

describe("the caption over a long log", () => {
  /**
   * The form was picked by the count shown, always 500, and the total after
   * "из" kept one form: "из 501 строк". The form now follows the total.
   */
  it("agrees the total with its noun in Russian", () => {
    expect(
      translate("ru", "share", "logsTail", { n: 501, shown: 500 })
    ).toContain("из 501 строки");
    expect(
      translate("ru", "share", "logsTail", { n: 505, shown: 500 })
    ).toContain("из 505 строк");
  });
});
