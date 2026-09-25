import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ProblemsPanel, WarningsPanel } from "./health";
import {
  nodesShare,
  problemsShare,
  warningsShare,
  workloadsShare,
} from "./health-share";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  ClusterOverview,
  ClusterProblem,
  NodeSummary,
  WarningGroup,
} from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";

const t: T = (section, key, values) => translate("en", section, key, values);

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

/** One sentence the scheduler writes, read by both panels. */
const MESSAGE = "Scaled up replica set meshed-demo-65d47b457f to 1";

const warning: WarningGroup = {
  reason: "ScalingReplicaSet",
  count: 3,
  lastSeen: new Date().toISOString(),
  sample: MESSAGE,
  objectKind: "Deployment",
  objectName: "meshed-demo",
  namespace: "k8s-gui-test",
};

const problem: ClusterProblem = {
  severity: "warning",
  kind: "Deployment",
  name: "meshed-demo",
  namespace: "k8s-gui-test",
  reason: "ScalingReplicaSet",
  detail: { says: "said", text: MESSAGE },
  since: new Date().toISOString(),
  restarts: null,
};

describe("the overview's two event panels", () => {
  it("linkify the same sentence the same way", () => {
    /** `Needs attention` has linkified this message since the segmenter
     *  shipped and `Warning events`, directly under it, rendered it dead —
     *  the same name, in the same words, live in one panel and text in the
     *  other. The group carried a `"Kind/name"` string and no namespace, so
     *  the segmenter had nothing to resolve the name against. */
    wrap(
      <>
        <ProblemsPanel
          problems={[problem]}
          problemsTruncated={0}
          pods={{
            running: 1,
            pending: 0,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            crashLooping: 0,
          }}
          nodes={[]}
          nodesKnown={true}
        />
        <WarningsPanel warnings={[warning]} known />
      </>
    );

    expect(
      screen.getAllByRole("link", { name: "ReplicaSet meshed-demo-65d47b457f" })
    ).toHaveLength(2);
  });

  it("offers the object a warning group is about", () => {
    /** The row already printed `Deployment/meshed-demo`; it was the one
     *  naming of an object on this screen that went nowhere. */
    wrap(<WarningsPanel warnings={[warning]} known />);

    expect(
      screen.getByRole("link", { name: "Deployment meshed-demo" })
    ).toHaveAttribute("href", "/deployments/k8s-gui-test/meshed-demo");
  });

  it("says the warnings are unknown when an events list failed", () => {
    /** A refused events list drew no panel at all, and a scope where one
     *  namespace refused showed the others' warnings as the whole. */
    const { container } = wrap(<WarningsPanel warnings={[]} known={false} />);
    expect(container).toHaveTextContent(
      "Not every events list was read in full, so warnings may be missing here."
    );
    wrap(<WarningsPanel warnings={[warning]} known={false} />);
    expect(screen.getAllByText(/Not every events list/)).toHaveLength(2);
    expect(screen.getByText("ScalingReplicaSet")).toBeInTheDocument();
  });

  it("draws nothing for warnings read and none found", () => {
    const { container } = wrap(<WarningsPanel warnings={[]} known />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders a group whose event named no object", () => {
    /** An event whose involved object the API server did not record is a
     *  real warning that still has to be read. */
    wrap(
      <WarningsPanel
        warnings={[
          { ...warning, objectKind: null, objectName: null, namespace: null },
        ]}
        known
      />
    );

    expect(screen.getByText("ScalingReplicaSet")).toBeInTheDocument();
  });
});

describe("the detail line on a problem row", () => {
  /** The row carries two unlike things. `said` is the cluster's own
   *  message and has to survive a language switch untouched; the rest are
   *  sentences this app composes and have to follow the reader. They were
   *  one `string` field until 2026-08-30, which is how "Marked
   *  unschedulable — no new pods will land here" came to sit on the first
   *  screen of a Russian interface. */
  it("follows the reader for our words and leaves the cluster's alone", () => {
    const panel = (problem: ClusterProblem) => (
      <ProblemsPanel
        problems={[problem]}
        problemsTruncated={0}
        pods={{
          running: 1,
          pending: 0,
          succeeded: 0,
          failed: 0,
          unknown: 0,
          crashLooping: 0,
        }}
        nodes={[]}
        nodesKnown={true}
      />
    );
    const cordoned: ClusterProblem = {
      severity: "warning",
      kind: "Node",
      name: "worker-1",
      namespace: null,
      reason: "Cordoned",
      detail: { says: "unschedulable" },
      since: null,
      restarts: null,
    };

    useLocaleStore.setState({ choice: "en" });
    const english = wrap(panel(cordoned));
    expect(english.getByText(/no new pods will land here/)).toBeInTheDocument();
    english.unmount();

    useLocaleStore.setState({ choice: "ru" });
    const russian = wrap(panel(cordoned));
    expect(russian.getByText(/новые поды сюда не поедут/)).toBeInTheDocument();
    expect(russian.queryByText(/no new pods/)).toBeNull();
    russian.unmount();

    // And the cluster's own sentence is still linkified, not looked up.
    useLocaleStore.setState({ choice: "ru" });
    const quoted = wrap(panel(problem));
    expect(
      quoted.getByRole("link", { name: "ReplicaSet meshed-demo-65d47b457f" })
    ).toBeInTheDocument();
    quoted.unmount();
    useLocaleStore.setState({ choice: null });
  });
});

describe("the healthy line when the node read was refused", () => {
  const pods = {
    running: 1,
    pending: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    crashLooping: 0,
  };

  /**
   * A namespace-scoped token cannot read the cluster's nodes, so "N of M
   * nodes ready" would be "0 of 0" — a healthy-looking lie. With the nodes
   * unknown the clause is left off entirely; deleting the `nodesKnown` guard
   * puts "0 of 0 nodes ready" back on a screen that just said "no access".
   */
  it("drops the nodes-ready clause when the nodes are unknown", () => {
    const { queryByText, unmount } = wrap(
      <ProblemsPanel
        problems={[]}
        problemsTruncated={0}
        pods={pods}
        nodes={[]}
        nodesKnown={false}
      />
    );
    expect(queryByText(/nodes ready/)).toBeNull();
    unmount();

    const known = wrap(
      <ProblemsPanel
        problems={[]}
        problemsTruncated={0}
        pods={pods}
        nodes={[]}
        nodesKnown={true}
      />
    );
    expect(known.getByText(/nodes ready/)).toBeInTheDocument();
    known.unmount();
  });
});

describe("what the panels offer Share", () => {
  /** Deleting the severity mapping breaks this: a critical problem would
   *  read the same colour as a warning one in a shared report. */
  it("carries each problem as a finding with a ref and the truncated tail", () => {
    const section = problemsShare(
      [problem, { ...problem, severity: "critical", reason: "CrashLoop" }],
      2,
      t
    );
    expect(section.count).toBe(4);
    expect(section.body.type).toBe("findings");
    const items = section.body.type === "findings" ? section.body.items : [];
    expect(items[0]).toMatchObject({
      title: "ScalingReplicaSet",
      role: "warn",
      ref: { kind: "Deployment", stem: "meshed-demo" },
    });
    expect(items[1]).toMatchObject({ title: "CrashLoop", role: "err" });
    expect(items[2]?.title).toContain("2");
  });

  /** A refused node count must not be read as zero Nodes; deleting the null
   *  guard turns "could not read" into a plain "None". */
  it("says a refused count could not be read instead of drawing it as none", () => {
    const overview = {
      counts: { deployments: 1, nodes: null, jobs: 0 },
      pods: {
        running: 1,
        pending: 0,
        succeeded: 0,
        failed: 0,
        unknown: 0,
        crashLooping: 0,
      },
      jobs: null,
      nodes: [],
      problems: [],
    } as unknown as ClusterOverview;
    const section = workloadsShare(overview, t);
    expect(section.body.type).toBe("facts");
    const rows = section.body.type === "facts" ? section.body.rows : [];
    const nodesRow = rows.find((row) => row.label === "Nodes");
    expect(nodesRow?.values[0]).toMatchObject({ text: "Could not be read" });
  });

  it("draws one table row per node, coloured by readiness", () => {
    const nodes: NodeSummary[] = [
      {
        name: "node-a",
        ready: true,
        schedulable: true,
        roles: ["control-plane"],
        podCount: 4,
        podCapacity: 110,
        cpu: { requested: 0, allocatable: 0, usage: null },
        memory: { requested: 0, allocatable: 0, usage: null },
      },
      {
        name: "node-b",
        ready: false,
        schedulable: true,
        roles: [],
        podCount: 0,
        podCapacity: null,
        cpu: { requested: 0, allocatable: 0, usage: null },
        memory: { requested: 0, allocatable: 0, usage: null },
      },
    ];
    const section = nodesShare(nodes, "1.31.0", t);
    expect(section.body.type).toBe("table");
    const rows = section.body.type === "table" ? section.body.rows : [];
    expect(rows[0].cells[1]).toMatchObject({ text: "Ready", role: "ok" });
    expect(rows[1].cells[1]).toMatchObject({ text: "NotReady", role: "err" });
  });

  /** The events body carries the object a warning is about; deleting the ref
   *  breaks the one link this row has back into the cluster. */
  it("carries the warned object as the event row's ref", () => {
    const section = warningsShare([warning], true, t);
    expect(section.body.type).toBe("events");
    const rows = section.body.type === "events" ? section.body.rows : [];
    expect(rows[0]).toMatchObject({
      reason: "ScalingReplicaSet",
      ref: { kind: "Deployment", stem: "meshed-demo" },
    });
  });

  it("marks the section unread when the events list failed", () => {
    const section = warningsShare([], false, t);
    expect(section.unread).toBe(
      "Not every events list was read in full, so warnings may be missing here."
    );
  });
});
