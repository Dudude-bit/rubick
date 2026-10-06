import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

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
