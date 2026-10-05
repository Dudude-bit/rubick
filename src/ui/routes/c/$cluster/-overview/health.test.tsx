import type { ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { renderWithRouter } from "@/test/render";
import { AttentionPanel, WarningsPanel } from "./health";
import {
  attentionShare,
  nodesShare,
  warningsShare,
  workloadsShare,
} from "./health-share";
import {
  attentionOf,
  type Attention,
  type AttentionInputs,
} from "@/lib/attention";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type {
  ClusterOverview,
  ClusterProblem,
  NodeSummary,
  PodComposition,
  WarningGroup,
} from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";

const t: T = (section, key, values) => translate("en", section, key, values);

const wrap = (ui: ReactElement) =>
  renderWithRouter(ui, { at: "/c/prod", route: "/c/$cluster" });

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

/** The panel's list, from the reader every surface uses, with every kind read. */
function attentionFrom(
  problems: ClusterProblem[],
  inputs: Partial<AttentionInputs> = {}
): Attention {
  return attentionOf(
    {
      overview: {
        problems,
        problemsTruncated: 0,
        unread: [],
      } as unknown as ClusterOverview,
      services: { every: [], published: () => undefined, unread: [] },
      ingresses: { data: { rows: [], unread: [] }, error: null },
      ingressHealth: () => {
        throw new Error("no Ingress here");
      },
      autoscalers: { data: { rows: [], unread: [] }, error: null },
      claims: { data: { rows: [], unread: [] }, error: null },
      now: Date.now(),
      ...inputs,
    },
    t
  );
}

const RUNNING: PodComposition = {
  running: 1,
  pending: 0,
  succeeded: 0,
  failed: 0,
  unknown: 0,
  crashLooping: 0,
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
  it("linkify the same sentence the same way", async () => {
    /** `Needs attention` has linkified this message since the segmenter
     *  shipped and `Warning events`, directly under it, rendered it dead —
     *  the same name, in the same words, live in one panel and text in the
     *  other. The group carried a `"Kind/name"` string and no namespace, so
     *  the segmenter had nothing to resolve the name against. */
    await wrap(
      <>
        <AttentionPanel
          attention={attentionFrom([problem])}
          pods={RUNNING}
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

  it("offers the object a warning group is about", async () => {
    /** The row already printed `Deployment/meshed-demo`; it was the one
     *  naming of an object on this screen that went nowhere. */
    await wrap(<WarningsPanel warnings={[warning]} known />);

    expect(
      screen.getByRole("link", { name: "Deployment meshed-demo" })
    ).toHaveAttribute("href", "/c/prod/deployments/k8s-gui-test/meshed-demo");
  });

  it("says the warnings are unknown when an events list failed", async () => {
    /** A refused events list drew no panel at all, and a scope where one
     *  namespace refused showed the others' warnings as the whole. */
    const { container } = await wrap(
      <WarningsPanel warnings={[]} known={false} />
    );
    expect(container).toHaveTextContent(
      "Not every events list was read in full, so warnings may be missing here."
    );
    await wrap(<WarningsPanel warnings={[warning]} known={false} />);
    expect(screen.getAllByText(/Not every events list/)).toHaveLength(2);
    expect(screen.getByText("ScalingReplicaSet")).toBeInTheDocument();
  });

  it("draws nothing for warnings read and none found", async () => {
    const { container } = await wrap(<WarningsPanel warnings={[]} known />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders a group whose event named no object", async () => {
    /** An event whose involved object the API server did not record is a
     *  real warning that still has to be read. */
    await wrap(
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
  it("follows the reader for our words and leaves the cluster's alone", async () => {
    const panel = (problem: ClusterProblem) => (
      <AttentionPanel
        attention={attentionFrom([problem])}
        pods={RUNNING}
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
    const english = await wrap(panel(cordoned));
    expect(english.getByText(/no new pods will land here/)).toBeInTheDocument();
    english.unmount();

    useLocaleStore.setState({ choice: "ru" });
    const russian = await wrap(panel(cordoned));
    expect(russian.getByText(/новые поды сюда не поедут/)).toBeInTheDocument();
    expect(russian.queryByText(/no new pods/)).toBeNull();
    russian.unmount();

    // And the cluster's own sentence is still linkified, not looked up.
    useLocaleStore.setState({ choice: "ru" });
    const quoted = await wrap(panel(problem));
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
  it("drops the nodes-ready clause when the nodes are unknown", async () => {
    const { queryByText, unmount } = await wrap(
      <AttentionPanel
        attention={attentionFrom([])}
        pods={pods}
        nodes={[]}
        nodesKnown={false}
      />
    );
    expect(queryByText(/nodes ready/)).toBeNull();
    unmount();

    const known = await wrap(
      <AttentionPanel
        attention={attentionFrom([])}
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
    const attention = attentionFrom([
      problem,
      { ...problem, severity: "critical", reason: "CrashLoop" },
    ]);
    const section = attentionShare({ ...attention, total: 4 }, t);
    expect(section.count).toBe(4);
    expect(section.body.type).toBe("findings");
    const items = section.body.type === "findings" ? section.body.items : [];
    expect(items[0]).toMatchObject({ title: "CrashLoop", role: "err" });
    expect(items[1]).toMatchObject({
      title: "ScalingReplicaSet",
      role: "warn",
      ref: { kind: "Deployment", stem: "meshed-demo" },
    });
    expect(items[2]?.title).toContain("2");
  });

  /** A report that dropped what was not checked would read as a clean bill. */
  it("names a kind the list could not read as a finding of its own", () => {
    const section = attentionShare(
      attentionFrom([], {
        autoscalers: { data: undefined, error: new Error("forbidden") },
      }),
      t
    );
    const items = section.body.type === "findings" ? section.body.items : [];
    expect(items).toEqual([
      expect.objectContaining({
        title: "HorizontalPodAutoscalers: could not be read",
        detail: "forbidden",
        role: "neutral",
      }),
    ]);
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

describe("what Needs attention says it checked", () => {
  const panel = (attention: Attention, pods: PodComposition = RUNNING) =>
    wrap(
      <AttentionPanel
        attention={attention}
        pods={pods}
        nodes={[]}
        nodesKnown={true}
      />
    );

  /**
   * Sam's `net`: the Services could not be looked at and the panel said
   * "nothing broken". A refused kind is named with the cluster's reason, and
   * the empty list is "nothing found in what could be checked", never
   * "nothing needs attention". Fails if the refused branch is folded into read.
   */
  it("never says nothing needs attention beside a kind it was refused", async () => {
    const refused = attentionFrom([], {
      services: {
        every: [],
        published: () => undefined,
        unread: [
          {
            namespace: "net",
            code: "PERMISSION_DENIED",
            message: 'services is forbidden: User "sam" cannot list services',
          },
        ],
      },
    });
    expect(refused.complete).toBe(false);

    const { container } = await panel(refused);

    expect(container).not.toHaveTextContent("nothing needs attention");
    expect(container).toHaveTextContent(
      "nothing found in what could be checked"
    );
    const unchecked = screen.getByTestId("attention-unchecked");
    expect(unchecked).toHaveTextContent("Services");
    expect(unchecked).toHaveTextContent("refused in net");
    expect(unchecked).toHaveTextContent('User "sam" cannot list services');
    expect(screen.getByTestId("attention-summary")).not.toHaveTextContent(
      "Healthy"
    );
  });

  /** Still reading is its own state: not refused, and not a clean answer either. */
  it("says a kind is still being read rather than calling the scope clean", async () => {
    const { container } = await panel(
      attentionFrom([], {
        claims: { data: undefined, error: null },
      })
    );

    expect(container).not.toHaveTextContent("nothing needs attention");
    const unchecked = screen.getByTestId("attention-unchecked");
    expect(unchecked).toHaveTextContent("PVCs");
    expect(unchecked).toHaveTextContent("still reading");
    expect(screen.getByTestId("attention-summary")).toHaveTextContent(
      "partly checked"
    );
  });

  /** The one state that earns the words, and the only one with a green dot. */
  it("says nothing needs attention only when every kind was read clean", async () => {
    const { container } = await panel(attentionFrom([]));

    expect(container).toHaveTextContent("nothing needs attention");
    expect(screen.queryByTestId("attention-unchecked")).toBeNull();
    const summary = screen.getByTestId("attention-summary");
    expect(summary).toHaveTextContent("Healthy");
    expect(summary.querySelector(".bg-ok")).not.toBeNull();
  });

  /**
   * Dana: a green "Healthy, 5 of 13 pods running" under six red rows. The
   * line counts pods without a verdict word, says what the rest are doing,
   * and its dot is the worst row's. Fails if "Healthy" or green comes back.
   */
  it("counts pods neutrally and wears the worst row's tone while problems stand", async () => {
    await panel(attentionFrom([{ ...problem, severity: "critical" }]), {
      running: 6,
      pending: 3,
      succeeded: 2,
      failed: 2,
      unknown: 0,
      crashLooping: 1,
    });

    const summary = screen.getByTestId("attention-summary");
    expect(summary).not.toHaveTextContent("Healthy");
    expect(summary).toHaveTextContent("5 of 13 pods running");
    expect(summary).toHaveTextContent(
      "(1 CrashLoop, 3 Pending, 2 Failed, 2 Completed)"
    );
    expect(summary.querySelector(".bg-err")).not.toBeNull();
    expect(summary.querySelector(".bg-ok")).toBeNull();
  });

  /** Fifty rows push the rest of the page off screen; the tail is a count and a way into each list. */
  it("caps the rows and links what it left out to each kind's list", async () => {
    const pods = Array.from({ length: 14 }, (_, at) => ({
      ...problem,
      kind: "Pod",
      name: `api-${at}`,
      severity: "critical" as const,
    }));
    await panel(attentionFrom(pods));

    expect(screen.getAllByRole("link", { name: /^Pod api-/ })).toHaveLength(12);
    expect(screen.getByText("and 2 more")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "2 Pods" })).toHaveAttribute(
      "href",
      "/c/prod/pods"
    );
  });
});
