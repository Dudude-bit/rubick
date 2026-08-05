import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EventInfo, PodInfo } from "@/generated/types";

vi.mock("@/lib/commands", () => ({
  commands: {
    getPod: vi.fn(),
    getManifest: vi.fn(),
    listEvents: vi.fn(),
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

function Probe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

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

describe("PeekPanel", () => {
  beforeEach(() => {
    vi.mocked(commands.getPod).mockReset().mockResolvedValue(buildPod());
    vi.mocked(commands.getManifest)
      .mockReset()
      .mockResolvedValue(NAMESPACE_MANIFEST);
    vi.mocked(commands.listEvents)
      .mockReset()
      .mockResolvedValue([buildEvent()]);
  });

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
