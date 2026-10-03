import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ContainerInfo, PodInfo } from "@/generated/types";

// The real one opens an exec session over Tauri and mounts xterm; neither is
// what this file is about.
vi.mock("./PodTerminal", () => ({
  PodTerminal: ({ containerName }: { containerName: string }) => (
    <div data-testid="pod-terminal">{containerName}</div>
  ),
}));

import { PodShell } from "./PodShell";

function container(overrides: Partial<ContainerInfo>): ContainerInfo {
  return {
    name: "app",
    image: "busybox:1.36",
    ready: true,
    phase: "app",
    state: { type: "running" },
    lastTerminated: null,
    restartCount: 0,
    ports: [],
    env: [],
    envFrom: [],
    ...overrides,
  } as ContainerInfo;
}

function pod(overrides: Partial<PodInfo>): PodInfo {
  return {
    name: "sidecar-demo",
    namespace: "k8s-gui-test",
    status: {
      phase: "Running",
      display: "Running",
      ready: true,
      conditions: [],
      message: null,
      reason: null,
    },
    containers: [],
    initContainers: [],
    labels: {},
    annotations: {},
    restartCount: 0,
    ...overrides,
  } as unknown as PodInfo;
}

const handlers = {
  onChoose: () => {},
  onOpenLogs: () => {},
  onDebug: () => {},
  onEnd: () => {},
};

/** `sidecar-demo`: a finished init container, a sidecar and an app container. */
const threeWay = pod({
  initContainers: [
    container({
      name: "prepare",
      phase: "init",
      ready: false,
      state: {
        type: "terminated",
        termination: {
          exitCode: 0,
          signal: null,
          reason: "Completed",
          message: null,
          startedAt: "2026-08-08T12:00:00Z",
          finishedAt: "2026-08-08T12:00:04Z",
        },
      },
    }),
  ],
  containers: [
    container({ name: "proxy", phase: "sidecar" }),
    container({ name: "app" }),
  ],
});

/**
 * One at a time, so the row is a chooser rather than the Logs legend it
 * resembles — and a container that cannot take a shell stays on it, struck out
 * and carrying the reason. A container that silently is not on the list makes
 * the reader wonder whether they misremembered its name.
 */
describe("PodShell's container chooser", () => {
  it("attaches to the app container when nobody has chosen", () => {
    render(
      <PodShell pod={threeWay} container={null} ended={false} {...handlers} />
    );
    expect(screen.getByTestId("pod-terminal")).toHaveTextContent("app");
    expect(screen.getByRole("radio", { name: /^app/ })).toBeChecked();
  });

  it("attaches to the sidecar when that is the one chosen", () => {
    render(
      <PodShell pod={threeWay} container="proxy" ended={false} {...handlers} />
    );
    expect(screen.getByTestId("pod-terminal")).toHaveTextContent("proxy");
  });

  it("keeps a finished container on the list, with why it cannot take one", () => {
    render(
      <PodShell pod={threeWay} container={null} ended={false} {...handlers} />
    );
    const prepare = screen.getByRole("radio", { name: /prepare/ });
    expect(prepare).toHaveTextContent("finished, nothing to attach to");
    expect(prepare).toBeDisabled();
  });

  it("hands the chosen name back rather than attaching on its own", async () => {
    const onChoose = vi.fn();
    render(
      <PodShell
        pod={threeWay}
        container={null}
        ended={false}
        {...handlers}
        onChoose={onChoose}
      />
    );
    await userEvent.click(screen.getByRole("radio", { name: /proxy/ }));
    expect(onChoose).toHaveBeenCalledWith("proxy");
  });

  it("says nothing is attached after the reader ends the session", () => {
    render(<PodShell pod={threeWay} container={null} ended {...handlers} />);
    expect(screen.queryByTestId("pod-terminal")).not.toBeInTheDocument();
    expect(screen.getByText(/No shell is attached/)).toBeInTheDocument();
  });
});

/**
 * The state a person actually meets, because the reason to want a shell is
 * usually that something is broken. It has to say why in the pod's own numbers
 * — a blank pane here reads as the app failing rather than as the pod having
 * nothing to attach to.
 */
describe("PodShell when there is nothing to attach to", () => {
  const initDemo = pod({
    name: "init-demo",
    status: {
      phase: "Pending",
      display: "Init:CrashLoopBackOff",
      ready: false,
      conditions: [],
      message: null,
      reason: null,
    },
    initContainers: [
      container({
        name: "wait-for-db",
        phase: "init",
        ready: false,
        state: {
          type: "terminated",
          termination: {
            exitCode: 0,
            signal: null,
            reason: "Completed",
            message: null,
            startedAt: null,
            finishedAt: "2026-08-08T12:45:41Z",
          },
        },
      }),
      container({
        name: "migrate",
        phase: "init",
        ready: false,
        restartCount: 33,
        state: { type: "waiting", reason: "CrashLoopBackOff" },
        lastTerminated: {
          exitCode: 1,
          signal: null,
          reason: "Error",
          message: null,
          startedAt: null,
          finishedAt: "2026-08-08T15:10:00Z",
        },
      }),
      container({
        name: "seed",
        phase: "init",
        ready: false,
        state: { type: "waiting", reason: "PodInitializing" },
      }),
    ],
    containers: [
      container({
        name: "app",
        ready: false,
        state: { type: "waiting", reason: "PodInitializing" },
      }),
    ],
  });

  it("names the step the pod is stuck on and how often it has failed", () => {
    render(
      <PodShell pod={initDemo} container={null} ended={false} {...handlers} />
    );
    // Whole sentences rather than clauses glued with "and" / "—": the join
    // was English grammar, and a sentence assembled from fragments cannot be
    // translated. Same facts, in the same order.
    expect(screen.getByTestId("shell-hollow")).toHaveTextContent(
      "The pod is still in init and stopped on migrate, which has failed 33 times. app has not started. wait-for-db, the init container that did run, has already exited. A shell needs a live process on the other end."
    );
  });

  it("offers the failed run's log and Debug, which are the two things that work", async () => {
    const onOpenLogs = vi.fn();
    render(
      <PodShell
        pod={initDemo}
        container={null}
        ended={false}
        {...handlers}
        onOpenLogs={onOpenLogs}
      />
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Read migrate's last run" })
    );
    expect(onOpenLogs).toHaveBeenCalledWith("migrate");
    expect(
      screen.getByRole("button", { name: /Debug with an ephemeral container/ })
    ).toBeInTheDocument();
  });

  it("draws no chooser at all when no container could take a shell", () => {
    render(
      <PodShell pod={initDemo} container={null} ended={false} {...handlers} />
    );
    expect(screen.queryByTestId("shell-chooser")).not.toBeInTheDocument();
  });
});
