import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

import type { ContainerInfo, PodInfo } from "@/generated/types";

// The real one opens an exec session over Tauri and mounts xterm; neither is
// what this file is about.
vi.mock("./PodTerminal", () => ({
  PodTerminal: ({
    containerName,
    onClose,
  }: {
    containerName: string;
    onClose: () => void;
  }) => (
    <div data-testid="pod-terminal">
      {containerName}
      <button type="button" aria-label="end the shell" onClick={onClose} />
    </div>
  ),
}));

import { PodShell } from "./PodShell";
import { renderWithProviders } from "@/test/render";

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
  named: null,
  onStart: () => {},
  onClaim: () => true,
  onChoose: () => {},
  onOpenLogs: () => {},
  onDebug: () => {},
  onEnd: () => {},
};

/** The reader asked for a shell in this container, and it is open. */
const askedIn = (container: string) => ({ container, ended: false });

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
  it("offers the app container when nobody has asked", () => {
    render(<PodShell pod={threeWay} asked={null} {...handlers} />);
    expect(screen.getByRole("radio", { name: /^app/ })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Start a shell in app" })
    ).toBeInTheDocument();
  });

  it("opens the shell in the container the reader asked for", () => {
    render(<PodShell pod={threeWay} asked={askedIn("proxy")} {...handlers} />);
    expect(screen.getByTestId("pod-terminal")).toHaveTextContent("proxy");
    expect(screen.getByRole("radio", { name: /^proxy/ })).toBeChecked();
  });

  /**
   * Dana's shell in `app` moved to the mesh proxy when `app` crashed: the pane
   * was thrown away with its scrollback and a prompt opened in a container she
   * never asked about. Fails if the shell follows the pod to whatever runs.
   */
  it("stays on the container asked for once it stops, with a sibling still running", () => {
    const crashed = pod({
      containers: [
        container({ name: "proxy", phase: "sidecar" }),
        container({
          name: "app",
          ready: false,
          state: {
            type: "waiting",
            reason: "CrashLoopBackOff",
            message: null,
          },
        }),
      ],
    });
    render(<PodShell pod={crashed} asked={askedIn("app")} {...handlers} />);
    expect(screen.getByTestId("pod-terminal")).toHaveTextContent(/^app$/);
  });

  /**
   * A debug container is not on the pod's own lists, and the shell the Debug
   * dialog asked for in it opened in the first app container under that name.
   * Fails if the pane opens anywhere but where it was asked.
   */
  it("opens the shell in a debug container the pod does not list", () => {
    render(
      <PodShell pod={threeWay} asked={askedIn("debugger-x7k2")} {...handlers} />
    );
    expect(screen.getByTestId("pod-terminal")).toHaveTextContent(
      /^debugger-x7k2$/
    );
  });

  it("keeps a finished container on the list, with why it cannot take one", () => {
    render(<PodShell pod={threeWay} asked={null} {...handlers} />);
    const prepare = screen.getByRole("radio", { name: /prepare/ });
    expect(prepare).toHaveTextContent("finished, nothing to attach to");
    expect(prepare).toBeDisabled();
  });

  it("hands the chosen name back rather than attaching on its own", async () => {
    const onChoose = vi.fn();
    render(
      <PodShell pod={threeWay} asked={null} {...handlers} onChoose={onChoose} />
    );
    await userEvent.click(screen.getByRole("radio", { name: /proxy/ }));
    expect(onChoose).toHaveBeenCalledWith("proxy");
  });

  /** Fails if ending the shell in the pane does not reach the page, which then goes on showing it open. */
  it("tells the page when the reader ends the shell", async () => {
    const onEnd = vi.fn();
    render(
      <PodShell
        pod={threeWay}
        asked={askedIn("app")}
        {...handlers}
        onEnd={onEnd}
      />
    );
    await userEvent.click(
      screen.getByRole("button", { name: "end the shell" })
    );
    expect(onEnd).toHaveBeenCalledOnce();
  });

  /**
   * Dana ended a shell and found a page that only a container chip could
   * restart. Fails if an ended shell re-attaches on its own, or if the page
   * offers nothing to start a new one in the container she had.
   */
  it("offers a new shell in the ended one's container and attaches nothing", async () => {
    const onStart = vi.fn();
    render(
      <PodShell
        pod={threeWay}
        asked={{ container: "proxy", ended: true }}
        {...handlers}
        onStart={onStart}
      />
    );
    expect(screen.queryByTestId("pod-terminal")).not.toBeInTheDocument();
    expect(screen.getByText("The shell was ended")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^proxy/ })).toBeChecked();

    await userEvent.click(
      screen.getByRole("button", { name: "Start a shell in proxy" })
    );
    expect(onStart).toHaveBeenCalledWith("proxy");
  });
});

/**
 * A page opened from a link or a restored tab lands on Shell with nobody
 * having asked, and the shell is a live process in someone's container.
 */
describe("PodShell before the reader asks for a shell", () => {
  /** Fails if landing on the tab mounts the terminal, which opens the exec. */
  it("offers to start one and attaches nothing", () => {
    render(<PodShell pod={threeWay} asked={null} {...handlers} />);
    expect(screen.queryByTestId("pod-terminal")).not.toBeInTheDocument();
    expect(
      screen.getByText("No shell is running here yet")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start a shell in app" })
    ).toBeInTheDocument();
  });

  /** Fails if the button does not hand the ask back to the page. */
  it("starts on the button", async () => {
    const onStart = vi.fn();
    render(
      <PodShell pod={threeWay} asked={null} {...handlers} onStart={onStart} />
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Start a shell in app" })
    );
    expect(onStart).toHaveBeenCalledWith("app");
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
      exitUnreported: false,
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
        state: { type: "waiting", reason: "CrashLoopBackOff", message: null },
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
        state: { type: "waiting", reason: "PodInitializing", message: null },
      }),
    ],
    containers: [
      container({
        name: "app",
        ready: false,
        state: { type: "waiting", reason: "PodInitializing", message: null },
      }),
    ],
  });

  it("names the step the pod is stuck on and how often it has failed", () => {
    renderWithProviders(<PodShell pod={initDemo} asked={null} {...handlers} />);
    // Whole sentences rather than clauses glued with "and" / "—": the join
    // was English grammar, and a sentence assembled from fragments cannot be
    // translated. Same facts, in the same order.
    expect(screen.getByTestId("shell-hollow")).toHaveTextContent(
      "The pod is still in init and stopped on migrate, which has failed 33 times. app has not started. wait-for-db, the init container that did run, has already exited. A shell needs a live process on the other end."
    );
  });

  /**
   * Evicted init-demo said "the pod is still in init" while its headline and
   * kubectl said Evicted. Fails if a failed pod's shell state goes back to
   * describing a sequence that is still going.
   */
  it("says a failed pod's containers will not run again", () => {
    const evicted = {
      ...initDemo,
      status: { ...initDemo.status, phase: "Failed", reason: "Evicted" },
    };
    renderWithProviders(<PodShell pod={evicted} asked={null} {...handlers} />);
    const hollow = screen.getByTestId("shell-hollow");
    expect(hollow).toHaveTextContent(
      "The pod is Evicted: it stopped in init on migrate, which has failed 33 times. None of its containers is running, and none will run again."
    );
    expect(hollow).not.toHaveTextContent("still in init");
  });

  it("offers the failed run's log and Debug, which are the two things that work", async () => {
    const onOpenLogs = vi.fn();
    renderWithProviders(
      <PodShell
        pod={initDemo}
        asked={null}
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
    renderWithProviders(<PodShell pod={initDemo} asked={null} {...handlers} />);
    expect(screen.queryByTestId("shell-chooser")).not.toBeInTheDocument();
  });

  /**
   * Dana's init-demo: the node had dropped migrate's failed run, and the
   * shell tab still said its answer was in that log. Fails if the line
   * promises a log the node no longer has.
   */
  it("says the node no longer has the failed run's log when the node says so", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_pod_logs"
        ? Promise.reject({
            code: "LOG_NOT_KEPT",
            message: "unable to retrieve container logs",
          })
        : undefined
    );
    renderWithProviders(<PodShell pod={initDemo} asked={null} {...handlers} />);
    expect(
      await screen.findByText("The node no longer has that run's log.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/shell would have told you/)).toBeNull();
  });

  /**
   * Dana's Evicted init-demo offered "Read migrate's last run" right under
   * "The node no longer has that run's log." Fails if the offer outlives
   * the node's answer.
   */
  it("withdraws the offer of a run's log once the node says it is gone", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_pod_logs"
        ? Promise.reject({ code: "LOG_NOT_KEPT", message: "gone" })
        : undefined
    );
    renderWithProviders(<PodShell pod={initDemo} asked={null} {...handlers} />);
    await screen.findByText("The node no longer has that run's log.");
    expect(
      screen.queryByRole("button", { name: "Read migrate's last run" })
    ).toBeNull();
  });

  /**
   * Where no line has said the log is gone, the offer stays and says why it
   * is greyed. Fails if it opens a Logs tab the node cannot fill, or goes
   * without a word.
   */
  it("greys the offer of a finished pod's log with the node's reason", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_pod_logs"
        ? Promise.reject({ code: "LOG_NOT_KEPT", message: "gone" })
        : undefined
    );
    const onOpenLogs = vi.fn();
    const ended = container({
      name: "app",
      ready: false,
      state: {
        type: "terminated",
        termination: {
          exitCode: 1,
          signal: null,
          reason: "Error",
          message: null,
          startedAt: "2026-08-08T12:00:00Z",
          finishedAt: "2026-08-08T12:00:04Z",
        },
      },
    });
    renderWithProviders(
      <PodShell
        pod={pod({
          status: {
            phase: "Failed",
            display: "Error",
            exitUnreported: false,
            ready: false,
            conditions: [],
            message: null,
            reason: null,
          },
          containers: [ended],
        } as Partial<PodInfo>)}
        asked={null}
        {...handlers}
        onOpenLogs={onOpenLogs}
      />
    );
    await vi.waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Read app's log" })
      ).toHaveAttribute("aria-disabled", "true")
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Read app's log" })
    );
    expect(onOpenLogs).not.toHaveBeenCalled();
  });
});

describe("PodShell where the cluster refuses this user", () => {
  const NO_EXEC =
    "Your access does not allow this: the cluster answers no to kubectl auth can-i create pods --subresource=exec -n k8s-gui-test.";
  const NO_EPHEMERAL =
    "Your access does not allow this: the cluster answers no to kubectl auth can-i patch pods --subresource=ephemeralcontainers -n k8s-gui-test.";

  /**
   * A reader who may not exec gets a terminal that fails as it opens. Fails
   * if the tab opens a session instead of saying the access refuses it.
   */
  it("opens no session and says the can-i question", () => {
    renderWithProviders(
      <PodShell
        pod={threeWay}
        asked={askedIn("app")}
        {...handlers}
        denied={{ shell: NO_EXEC }}
      />
    );
    expect(screen.queryByTestId("pod-terminal")).toBeNull();
    expect(screen.getByText("No shell with this access")).toBeInTheDocument();
    expect(screen.getByText(NO_EXEC)).toBeInTheDocument();
  });

  /** Fails if the stuck pod's Debug link stays live while the review says no. */
  it("greys the Debug way out of a stuck pod", async () => {
    const onDebug = vi.fn();
    renderWithProviders(
      <PodShell
        pod={pod({
          status: {
            phase: "Pending",
            display: "Init:0/1",
            exitUnreported: false,
            ready: false,
            conditions: [],
            message: null,
            reason: null,
          },
          containers: [
            container({
              ready: false,
              state: {
                type: "waiting",
                reason: "PodInitializing",
                message: null,
              },
            }),
          ],
        } as Partial<PodInfo>)}
        asked={null}
        {...handlers}
        onDebug={onDebug}
        denied={{ ephemeral: NO_EPHEMERAL }}
      />
    );
    const debug = screen.getByRole("button", {
      name: /Debug with an ephemeral container/,
    });
    expect(debug).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(debug);
    expect(onDebug).not.toHaveBeenCalled();
  });
});
