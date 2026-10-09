import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { CellContext, ColumnDef } from "@/components/ui/table-features";

import type { PodComposition, PodInfo, RowContainer } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { podRole, podStatusValue } from "@/lib/share/pod-status";
import { WORKLOAD_SOURCES } from "../../../-peek/peek-sources-workloads";
import { podSegments, podsServing } from "../../../-overview/health-share";
import { columns } from "./PodList";

const t: T = (section, key, values) => translate("en", section, key, values);

/**
 * The status column, rendered on its own.
 *
 * The cell is the whole subject here — mounting the page would drag in the
 * cluster store, three queries and a table just to read one badge.
 */
type Row = {
  status: { display: string; phase: string };
  containers?: RowContainer[];
  initContainers?: RowContainer[];
  nodeSilence?: unknown;
};

function statusCell(original: Row) {
  const column = (columns as ColumnDef<Row>[]).find((c) => c.id === "status");
  if (!column || typeof column.cell !== "function") {
    throw new Error("the pod list has no status column with a renderer");
  }
  const context = {
    row: { original: { containers: [], initContainers: [], ...original } },
  } as unknown as CellContext<Row, unknown>;
  return column.cell(context);
}

const RUNNING = { display: "Running", phase: "Running" };

describe("a pod whose node stopped reporting", () => {
  /**
   * The defect this exists for. When a node stops answering, nothing rewrites
   * its pods: `Running` stays written until eviction, five minutes later by
   * default and never at all for a StatefulSet until the node object goes. A
   * client that draws that confidently is reporting a moment that has passed.
   */
  it("keeps kubectl's label but stops sounding certain about it", () => {
    render(
      <>
        {statusCell({
          status: RUNNING,
          nodeSilence: { node: "n1", since: null, reason: null },
        })}
      </>
    );

    // The label is not softened — this IS the status the cluster holds, and a
    // second opinion invented here would be a different lie.
    const badge = screen.getByText("Running");
    expect(badge).toBeInTheDocument();

    // The colour is what drops: neutral is this app's "no opinion" role.
    expect(badge.closest("[title]")?.className ?? badge.className).toContain(
      "text-fg-mut"
    );
  });

  it("says which node went quiet, and that the status is old rather than wrong", () => {
    render(
      <>
        {statusCell({
          status: RUNNING,
          nodeSilence: {
            node: "worker-3",
            since: new Date(Date.now() - 240_000).toISOString(),
            reason: "NodeStatusUnknown",
          },
        })}
      </>
    );

    const titled = screen.getByTitle(/worker-3/);
    expect(titled.getAttribute("title")).toContain("stopped reporting 4m ago");
    expect(titled.getAttribute("title")).toContain("last one it sent");
  });
});

describe("a pod whose node is answering", () => {
  /** Would have fired the warning on every healthy cluster. */
  it("is drawn exactly as before, with its meaning in the tooltip", () => {
    render(<>{statusCell({ status: RUNNING })}</>);

    const badge = screen.getByText("Running");
    expect(badge.className).not.toContain("text-fg-mut");
    expect(screen.getByTitle(/^Running: placed on a node/)).toBeInTheDocument();
  });

  /** The role still comes from the status, not from the node. */
  it("still reads a crash loop as an error", () => {
    render(
      <>
        {statusCell({
          status: { display: "CrashLoopBackOff", phase: "Running" },
        })}
      </>
    );
    expect(screen.getByText("CrashLoopBackOff").className).toContain(
      "text-err"
    );
  });
});

describe("a pod up and failing its readiness probe", () => {
  /** `shop/search-77fbd8f66-52kp8` as kubectl saw it: `Running`, `0/1`. */
  const search = (ready: boolean) => ({
    name: "search-77fbd8f66-52kp8",
    namespace: "shop",
    status: {
      display: "Running",
      phase: "Running",
      message: null,
      reason: null,
    },
    containers: [
      {
        name: "search",
        ready,
        started: true,
        phase: "app" as const,
        state: { type: "running" as const },
      },
    ],
    initContainers: [],
    nodeName: "node01",
    podIp: "192.168.1.187",
    restartCount: 0,
    lastRestartAt: null,
    createdAt: "2026-10-06T21:20:11Z",
    ownerReferences: [],
    cpuRequests: null,
    cpuLimits: null,
    memoryRequests: null,
    memoryLimits: null,
  });

  /**
   * Dana's Pods list drew `Running` with a green check for a pod `0/1`
   * ready, its readiness probe answering 404. Fails if the list, the peek,
   * the workload's Pods rows or Share paint it green, or if they disagree.
   */
  it("keeps kubectl's word and is amber on every surface that draws it", () => {
    const pod = search(false);
    render(<>{statusCell(pod)}</>);

    const badge = screen.getByText("Running");
    expect(badge.className).toContain("text-warn");
    expect(
      screen.getByTitle(/Ready 0\/1: the containers run, but the pod fails/)
    ).toBeInTheDocument();
    const peek = WORKLOAD_SOURCES.Pod!.summarise(
      pod as unknown as PodInfo,
      { kind: "Pod", name: pod.name, namespace: pod.namespace },
      t
    );
    expect(peek.status).toBe("Running");
    expect(peek.statusRole).toBe("warn");
    expect(podRole(pod, null)).toBe("warn");
    expect(podStatusValue(pod, null, t)).toEqual({
      text: "Running",
      role: "warn",
    });
    expect(podRole(search(true), null)).toBe("ok");
  });

  /**
   * "6 of 14 pods running" beside kubectl's 5 ready: the Overview's count
   * of pods serving has to be the pods the list draws green. Fails if a pod
   * up and not ready is green in one place and counted as serving in the other.
   */
  it("is the pod the Overview leaves out of the ones serving", () => {
    const pods = [search(false), search(true)];
    const composition: PodComposition = {
      running: 2,
      pending: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      crashLooping: 0,
      notReady: 1,
      stuck: [],
      starting: 0,
    };

    expect(podsServing(composition)).toBe(
      pods.filter((pod) => podRole(pod, null) === "ok").length
    );
    expect(
      podSegments(composition, t).find(
        (segment) => segment.label === "NotReady"
      )
    ).toEqual({ label: "NotReady", count: 1, tone: "warn" });
  });
});

describe("a pod up between the crashes of a loop", () => {
  const checkout = (secondsAgo: number) => ({
    name: "checkout-55cbfdc66-msfk6",
    namespace: "shop",
    status: {
      display: "Running",
      phase: "Running",
      loopingExitAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    },
    containers: [
      {
        name: "app",
        ready: true,
        started: true,
        phase: "app" as const,
        state: { type: "running" as const },
      },
    ],
    initContainers: [],
  });

  /**
   * Sam's checkout pod read green Running on its Logs tab while its
   * Overview said CrashLoopBackOff a moment before. Fails if the list, the
   * peek or the header badge paint the running instant of a loop green, or
   * if a pod whose last crash is past the window stays red.
   */
  it("keeps kubectl's word and is red on every surface while the loop is recent", () => {
    const pod = checkout(20);
    render(<>{statusCell(pod)}</>);
    expect(screen.getByText("Running").className).toContain("text-err");
    expect(screen.getByTitle(/Up between crashes/)).toBeInTheDocument();
    const peek = WORKLOAD_SOURCES.Pod!.summarise(
      pod as unknown as PodInfo,
      { kind: "Pod", name: pod.name, namespace: pod.namespace },
      t
    );
    expect(peek.statusRole).toBe("err");
    expect(podRole(checkout(20 * 60), null)).toBe("ok");
  });

  /**
   * Sam's recommendations row read OOMKilled with "Up between crashes"
   * under it. Fails if the between-crashes words reach a word that is not
   * the running instant of the loop.
   */
  it.each(["OOMKilled", "Error", "CrashLoopBackOff", "Completed"])(
    "says nothing about being up between crashes on a %s row",
    (display) => {
      const pod = checkout(20);
      const { container } = render(
        <>{statusCell({ ...pod, status: { ...pod.status, display } })}</>
      );
      const titles = [...container.querySelectorAll("[title]")].map((el) =>
        el.getAttribute("title")
      );
      expect(titles.join("\n")).not.toMatch(/between crashes/);
    }
  );
});

describe("a pod that restarted with no exit reported", () => {
  const checkout = (exitUnreported: boolean) => ({
    name: "checkout-7596d7fc77-fwk7g",
    namespace: "shop",
    restartCount: 15,
    lastRestartAt: null,
    status: { display: "Running", phase: "Running", exitUnreported },
    containers: [
      {
        name: "app",
        ready: true,
        started: true,
        phase: "app" as const,
        state: { type: "running" as const },
      },
    ],
    initContainers: [],
  });

  /**
   * Sam's checkout pod, fifteen restarts and no lastState from the kubelet,
   * read green Running with no word about either. Fails if the list or the
   * peek draws it green, drops the sentence saying the last exit is not
   * reported, or the peek's restarts row stops saying so.
   */
  it("is amber on every surface and says the last exit is not reported", () => {
    const pod = checkout(true);
    render(<>{statusCell(pod)}</>);
    expect(screen.getByText("Running").className).toContain("text-warn");
    expect(
      screen.getByTitle(/the kubelet reports no last exit/)
    ).toBeInTheDocument();
    const peek = WORKLOAD_SOURCES.Pod!.summarise(
      pod as unknown as PodInfo,
      { kind: "Pod", name: pod.name, namespace: pod.namespace },
      t
    );
    expect(peek.statusRole).toBe("warn");
    const restarts = peek.groups
      ?.flatMap((group) => group.items)
      .find((item) => item.label === t("columns", "restarts"));
    expect(restarts?.value).toBe("15 restarts, last exit not reported");
    expect(podRole(checkout(false), null)).toBe("ok");
  });
});

describe("a pod Pending past the wait it is given", () => {
  const neverPlaced = (secondsLeft: number) => ({
    name: "never-placed-5d8f7c9b6-x2x9q",
    namespace: "shop",
    status: { display: "Pending", phase: "Pending" },
    start: {
      state: "starting" as const,
      until: new Date(Date.now() + secondsLeft * 1000).toISOString(),
    },
    containers: [],
    initContainers: [],
  });

  /**
   * Sam's never-placed pod stayed blue Pending on the Pods list and its page
   * at two and a half minutes while the Overview tile had counted it amber
   * since its first minute ran out. Fails if the list or the peek keeps a
   * pod blue past its wait, or turns one amber inside it.
   */
  it("turns amber on the list and the peek the moment its wait runs out", () => {
    render(<>{statusCell(neverPlaced(-90))}</>);
    expect(screen.getByText("Pending").className).toContain("text-warn");
    expect(screen.getByTitle(/Pending past the wait/)).toBeInTheDocument();
    const peek = (pod: ReturnType<typeof neverPlaced>) =>
      WORKLOAD_SOURCES.Pod!.summarise(
        pod as unknown as PodInfo,
        { kind: "Pod", name: pod.name, namespace: pod.namespace },
        t
      ).statusRole;
    expect(peek(neverPlaced(-90))).toBe("warn");
    expect(peek(neverPlaced(30))).toBe("pending");
    expect(podRole(neverPlaced(30), null)).toBe("pending");
  });
});
