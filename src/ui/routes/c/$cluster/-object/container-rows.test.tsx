import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

import type { AccessQuery, PodInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";

import type { ContainerInfo, DeploymentContainerInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";
import { ContainerRows } from "./container-rows";

function declared(
  probes: DeploymentContainerInfo["probes"]
): DeploymentContainerInfo {
  return {
    name: "app",
    image: "nginx:1.27-alpine",
    phase: "app",
    ports: [80],
    resources: { requests: { cpu: "5m" }, limits: {} },
    probes,
    env: [],
    envFrom: [],
    command: [],
    args: [],
  };
}

const render = (container: DeploymentContainerInfo) =>
  renderWithRouter(
    <ContainerRows
      template={{ containers: [container], initContainers: [] }}
      namespace="shop"
    />
  );

describe("a template's probes on the Template tab", () => {
  /**
   * Dana found `search`'s cause, a readiness path of `/healthz` answering
   * 404, only at line 42 of the YAML. The tab listed image, ports, requests
   * and limits, and no probe.
   */
  it("shows a readiness probe's handler, target and timings as kubectl describe prints them", async () => {
    await render(
      declared({
        readiness: {
          handler: {
            type: "httpGet",
            path: "/healthz",
            port: "http",
            scheme: "HTTP",
            host: null,
          },
          initialDelaySeconds: 0,
          periodSeconds: 5,
          timeoutSeconds: 1,
          successThreshold: 1,
          failureThreshold: 3,
        },
        liveness: null,
        startup: null,
      })
    );
    expect(screen.getByText("Readiness")).toBeInTheDocument();
    expect(
      screen.getByText("http-get http://:http/healthz")
    ).toBeInTheDocument();
    expect(
      screen.getByText("delay=0s timeout=1s period=5s #success=1 #failure=3")
    ).toBeInTheDocument();
    expect(screen.queryByText("Liveness")).toBeNull();
  });

  /** A container with no probe at all says so, rather than leaving the reader to wonder whether the tab reads them. */
  it("says there are no probes when none is declared", async () => {
    await render(declared({ readiness: null, liveness: null, startup: null }));
    expect(screen.getByText("Probes")).toBeInTheDocument();
  });
});

describe("a running pod's containers on the Containers tab", () => {
  /** The recommendations pod: busybox with a 24Mi limit, killed for it. */
  const oomKilled = {
    name: "app",
    image: "busybox:1.36",
    ready: false,
    started: false,
    phase: "app",
    state: { type: "waiting", reason: "CrashLoopBackOff" },
    lastTerminated: {
      exitCode: 137,
      signal: null,
      reason: "OOMKilled",
      message: null,
      startedAt: null,
      finishedAt: null,
    },
    restartCount: 7,
    ports: [],
    resources: {
      requests: { cpu: "5m", memory: "16Mi" },
      limits: { memory: "24Mi" },
    },
    env: [],
    envFrom: [],
  } satisfies ContainerInfo;

  /**
   * Dana read "exit 137" on the Containers tab and no memory limit next to
   * it. Fails if a pod's container stops showing its own requests and
   * limits.
   */
  it("shows the container's own requests and limits", async () => {
    await renderWithRouter(
      <ContainerRows
        pod={{ containers: [oomKilled], initContainers: [] }}
        namespace="shop"
        podName="recommendations-5c68fb6c5c-tvlbm"
      />
    );
    expect(screen.getByText("memory 24Mi")).toBeInTheDocument();
    expect(screen.getByText("cpu 5m · memory 16Mi")).toBeInTheDocument();
  });
});

describe("a running container for a reader who may neither exec nor forward", () => {
  /**
   * The container's Shell and its port's forward were live for a reader the
   * cluster refuses both. Fails if either stays runnable, or if the port
   * still opens its dialog.
   */
  it("greys Shell and the port, each with its can-i question", async () => {
    useClusterStore.setState((s) => ({
      currentContext: "acme-staging",
      isConnected: true,
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    vi.mocked(invoke).mockImplementation(async (command: string, args) =>
      command === "check_access"
        ? (args as { queries: AccessQuery[] }).queries.map((query) => ({
            ...query,
            allowed: false,
          }))
        : undefined
    );
    const pod = {
      name: "checkout-api-6767fbfdb7-blpfk",
      namespace: "team-checkout",
      initContainers: [],
      containers: [
        {
          name: "api",
          image: "ghcr.io/acme/checkout-api:1.4.2",
          phase: "app",
          ready: true,
          started: true,
          restartCount: 0,
          resources: { requests: {}, limits: {} },
          state: { type: "running", startedAt: "2026-10-06T21:00:00Z" },
          lastTerminated: null,
          ports: [{ containerPort: 8080, name: null, protocol: "TCP" }],
          env: [],
          envFrom: [],
        },
      ],
    } as unknown as PodInfo;
    await renderWithRouter(
      <ContainerRows
        pod={pod}
        namespace="team-checkout"
        podName={pod.name}
        onOpenShell={vi.fn()}
        shellDenied="Your access does not allow this: the cluster answers no to kubectl auth can-i create pods/exec -n team-checkout."
      />
    );

    expect(screen.getByRole("button", { name: "Shell" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "8080/TCP" })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "8080/TCP" }));
    expect(screen.queryByText("Start port-forward")).toBeNull();
    vi.mocked(invoke).mockImplementation(async () => undefined);
  });
});
