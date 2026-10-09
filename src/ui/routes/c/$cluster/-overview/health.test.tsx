import type { ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithRouter } from "@/test/render";
import { AttentionPanel, WarningsPanel, WorkloadsPanel } from "./health";
import {
  attentionShare,
  deploymentSegments,
  jobSegments,
  nodesShare,
  podSegments,
  warningsShare,
  workloadsShare,
} from "./health-share";
import {
  attentionOf,
  type Attention,
  type AttentionInputs,
} from "@/lib/attention";
import { translate } from "@/i18n";
import {
  ownCountedWord,
  ownStatusWord,
  rolloutCountedWord,
} from "@/lib/status-words";
import { JOB } from "@/lib/status-meaning";
import type { T } from "@/i18n/useT";
import type {
  Census,
  ClusterOverview,
  ClusterProblem,
  IngressHealthInput,
  NodeSummary,
  PodComposition,
  WarningGroup,
} from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";
import { ingressHealthOf } from "@/lib/ingress-health";

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
      services: { answered: [], unread: [] },
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

const RUNNING: Census<PodComposition> = {
  read: {
    running: 1,
    pending: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    crashLooping: 0,
    notReady: 0,
    ready: 1,
    stuck: [],
    starting: 0,
  },
  complete: true,
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
  foldedPods: null,
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
          podsUnread={[]}
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
        podsUnread={[]}
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
      foldedPods: null,
    };

    useLocaleStore.setState({ choice: "en" });
    const english = await wrap(panel(cordoned));
    expect(english.getByText(/no new pods will land here/)).toBeInTheDocument();
    english.unmount();

    useLocaleStore.setState({ choice: "ru" });
    const russian = await wrap(panel(cordoned));
    expect(russian.getByText(/новые поды сюда не попадут/)).toBeInTheDocument();
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

describe("the reason on a problem row", () => {
  const stalled: ClusterProblem = {
    severity: "critical",
    kind: "Deployment",
    name: "cart",
    namespace: "shop",
    reason: "Stalled",
    detail: null,
    since: null,
    restarts: null,
    foldedPods: null,
  };

  /**
   * A Stalled Deployment's row read "Stalled" among Russian rows while its
   * list badge said "Застрял". Fails if the row goes back to the code, or
   * words a reason the cluster wrote.
   */
  it("words the app's own verdict in the reader's language", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      const { unmount } = await wrap(
        <AttentionPanel
          attention={attentionFrom([
            stalled,
            { ...stalled, kind: "Pod", name: "cart-0", reason: "OOMKilled" },
          ])}
          pods={RUNNING}
          podsUnread={[]}
          nodes={[]}
          nodesKnown={true}
        />
      );
      expect(screen.getByText("Застрял")).toBeInTheDocument();
      expect(screen.queryByText("Stalled")).toBeNull();
      expect(screen.getByText("OOMKilled")).toBeInTheDocument();
      unmount();
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });
});

describe("the Needs attention heading", () => {
  /**
   * Marco's team-checkout: the heading said "3" while the sidebar badge
   * said "3+" and the status bar "3 problems, not all checked" over the
   * same count. Fails if a count some kind went unread for heads the panel
   * without its "+" and the words the other surfaces use.
   */
  it("marks a count some kind went unread for as the floor it is", async () => {
    const attention = attentionFrom([problem, { ...problem, name: "cart" }], {
      services: {
        answered: [],
        unread: [
          { namespace: "team-checkout", code: "", message: "forbidden" },
        ],
      },
    });
    expect(attention.complete).toBe(false);
    const { unmount } = await wrap(
      <AttentionPanel
        attention={attention}
        pods={RUNNING}
        podsUnread={[]}
        nodes={[]}
        nodesKnown={true}
      />
    );
    expect(
      screen.getByText("2+ · worst first · not all checked")
    ).toBeInTheDocument();
    unmount();
  });
});

describe("the healthy line when the node read was refused", () => {
  const pods = RUNNING;

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
        podsUnread={[]}
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
        podsUnread={[]}
        nodes={[]}
        nodesKnown={true}
      />
    );
    expect(known.getByText(/nodes ready/)).toBeInTheDocument();
    known.unmount();
  });
});

describe("a scope one namespace of which refused its pods", () => {
  const refusedIn = (kind: string, plural: string) => ({
    kind,
    namespace: "team-blind",
    code: "PERMISSION_DENIED",
    message: `${plural} is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "${plural}" in API group "" in the namespace "team-blind"`,
  });
  const refusedPods = refusedIn("Pod", "pods");
  const overview = {
    counts: { pods: null, deployments: 1, nodes: null, jobs: null },
    pods: null,
    jobs: null,
    deployments: {
      read: [{ reason: "Unavailable", count: 1, podsUnread: true }],
      complete: true,
    },
    nodes: [],
    problems: [],
    problemsTruncated: 0,
    unread: [refusedPods],
  } as unknown as ClusterOverview;

  /** Marco's team-checkout read in full beside team-blind, which refused its pods and Jobs. */
  const beside = {
    counts: { pods: null, deployments: 3, nodes: null, jobs: null },
    pods: {
      read: {
        running: 2,
        pending: 1,
        succeeded: 1,
        failed: 0,
        unknown: 0,
        crashLooping: 0,
        notReady: 0,
        ready: 2,
        stuck: [{ reason: "CreateContainerConfigError", count: 1 }],
        starting: 0,
      },
      complete: false,
    },
    jobs: { read: [{ reason: "Complete", count: 1 }], complete: false },
    deployments: {
      read: [
        { reason: "Ready", count: 1 },
        { reason: "Unavailable", count: 2 },
      ],
      complete: true,
    },
    nodes: [],
    problems: [],
    problemsTruncated: 0,
    unread: [refusedPods, refusedIn("Job", "jobs")],
  } as unknown as ClusterOverview;

  /**
   * Marco's ledger: its pods refused, and the Deployments bar drew it red
   * "1 Unavailable" beside a list, a page and a peek drawing it grey with
   * the not-read mark. Fails if the census paints the controller's word in
   * its own colour, drops the mark, or Share's row loses either.
   */
  it("draws a verdict its pods left unconfirmed grey with the not-read mark", async () => {
    await wrap(<WorkloadsPanel overview={overview} scope="team-blind" />);
    const segment = screen.getByText("1 Unavailable").parentElement!;
    expect(segment).toHaveTextContent("1 Unavailable pods not read");
    expect(segment).toHaveClass("text-fg-fnt");
    expect(segment).not.toHaveClass("text-err");
    expect(segment.querySelector("svg")).toHaveClass("lucide-eye-off");

    const rows = workloadsShare(overview, t).body;
    const deployments =
      rows.type === "facts"
        ? rows.rows.find((row) => row.label === "Deployments")
        : undefined;
    expect(deployments?.values).toEqual([
      {
        text: "1 Unavailable · pods not read",
        role: "neutral",
        unread: true,
      },
    ]);
  });

  /**
   * Marco's two namespaces: the overview was one refusal for both. Read,
   * the pods tile is the one that cannot state a total, and says where.
   * Fails if it prints a count, or the refusal loses its namespace.
   */
  it("leaves the pods tile without a total and names where it was refused", async () => {
    await wrap(
      <WorkloadsPanel overview={overview} scope="team-blind, team-checkout" />
    );

    expect(screen.getByText("Pods").parentElement).toHaveTextContent(
      "not read"
    );
    expect(screen.getByText("in team-blind")).toBeInTheDocument();
    expect(screen.getByText("Deployment").parentElement).toHaveTextContent("1");
  });

  /**
   * Marco with team-checkout and team-blind: the Pods and Jobs tiles said
   * "not read" and dropped team-checkout's 4 pods and its Job, which were
   * read. Fails if a tile draws what one namespace answered as nothing, or
   * as the scope's whole total with no word that team-blind was not read.
   */
  it("draws what the namespaces that answered hold and says where the rest was not read", async () => {
    await wrap(
      <WorkloadsPanel overview={beside} scope="team-checkout, team-blind" />
    );

    const pods = screen.getByText("Pods").closest("div")!.parentElement!;
    expect(pods).toHaveTextContent("4");
    expect(pods).toHaveTextContent("2 Running");
    expect(pods).toHaveTextContent("not read in team-blind");
    expect(pods).not.toHaveTextContent("not readable with this access");
    const jobs = screen.getByText("Job").closest("div")!.parentElement!;
    expect(jobs).toHaveTextContent("1 Complete");
    expect(jobs).toHaveTextContent("not read in team-blind");
    const deployments = screen
      .getByText("Deployments")
      .closest("div")!.parentElement!;
    expect(deployments).toHaveTextContent("3");
    expect(deployments).not.toHaveTextContent("team-blind");
    expect(screen.getAllByText("in team-blind")).toHaveLength(2);
  });

  /**
   * Marco in Russian at 1024: three tiles broke their not-read lines
   * mid-phrase, "не прочитано в пространстве / имён team-blind" and
   * "1 Unavailable · поды не / прочитаны". Fails if a tile can break inside
   * the where, or inside the count or its qualifier, rather than between
   * them.
   */
  it("wraps a tile's not-read words only between whole phrases", async () => {
    await wrap(
      <WorkloadsPanel overview={beside} scope="team-checkout, team-blind" />
    );
    for (const where of screen.getAllByText("in team-blind"))
      expect(where).toHaveClass("inline-block", "max-w-full");

    cleanup();
    await wrap(<WorkloadsPanel overview={overview} scope="team-blind" />);
    const count = screen.getByText("1 Unavailable");
    const qualifier = screen.getByText("pods not read");
    expect(count).toHaveClass("whitespace-nowrap");
    expect(qualifier).toHaveClass("whitespace-nowrap");
    expect(count.contains(qualifier)).toBe(false);
  });

  /**
   * A tile with nothing in the namespaces that answered said "none in
   * scope" while another namespace of the scope was never read. Fails if a
   * partial zero claims the scope.
   */
  it("says none where it could be read for a partial zero", async () => {
    await wrap(
      <WorkloadsPanel
        overview={
          {
            ...beside,
            jobs: { read: [], complete: false },
          } as ClusterOverview
        }
        scope="team-checkout, team-blind"
      />
    );

    const jobs = screen.getByText("Jobs").closest("div")!.parentElement!;
    expect(jobs).toHaveTextContent("none where it could be read");
    expect(jobs).not.toHaveTextContent("none in scope");
  });

  /**
   * Marco: the overall row was a red dot and the word "overall" with nothing
   * beside it once team-blind refused its pods. Fails if the line states
   * "0 of 0 pods ready" for pods nobody read, or says nothing at all.
   */
  it("says the pods went uncounted where nothing was counted", async () => {
    await wrap(
      <AttentionPanel
        attention={attentionFrom([], { overview } as Partial<AttentionInputs>)}
        pods={null}
        podsUnread={[refusedPods]}
        nodes={[]}
        nodesKnown={false}
      />
    );
    const overall = screen.getByTestId("attention-overall");
    expect(overall).not.toHaveTextContent(/pods ready/);
    expect(overall).toHaveTextContent("pods not counted in team-blind");
    const unchecked = screen.getByTestId("attention-unchecked");
    expect(unchecked).toHaveTextContent("Pods");
    expect(unchecked).toHaveTextContent("may not list in team-blind");
  });

  /**
   * Marco's Not checked block read "нет права на list", half Russian and
   * half API. Fails if the Russian line loses the verb as the API spells it,
   * or the verb stops reading as a term.
   */
  it("names the refused verb as the API spells it, inside a Russian sentence", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      await wrap(
        <AttentionPanel
          attention={attentionFrom([], {
            overview,
          } as Partial<AttentionInputs>)}
          pods={null}
          podsUnread={[refusedPods]}
          nodes={[]}
          nodesKnown={false}
        />
      );
      const unchecked = screen.getByTestId("attention-unchecked");
      expect(unchecked).toHaveTextContent(
        "запрос list запрещён в пространстве имён team-blind"
      );
      expect(within(unchecked).getAllByText("list")[0]).toHaveClass(
        "font-mono"
      );
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });

  /**
   * Fails if the overall row states the pods team-checkout answered as the
   * scope's, or drops them because team-blind refused.
   */
  it("states the pods it counted and where it could not count", async () => {
    await wrap(
      <AttentionPanel
        attention={attentionFrom([], {
          overview: beside,
        } as Partial<AttentionInputs>)}
        pods={beside.pods}
        podsUnread={[refusedPods]}
        nodes={[]}
        nodesKnown={false}
      />
    );
    const overall = screen.getByTestId("attention-overall");
    expect(overall).toHaveTextContent(
      "2 of 4 pods ready (1 CreateContainerConfigError, 1 Completed)"
    );
    expect(overall).toHaveTextContent("pods not counted in team-blind");
  });

  /**
   * Marco in Russian at 1024: the overall row ended "(1
   * CreateContainerConfigErr..." and the words saying team-blind's pods were
   * not counted were the part cut off. Fails if the qualifier sits inside
   * anything that truncates, or the details are not what gives way.
   */
  it("lets the details give way on the overall row and never the not-counted words", async () => {
    await wrap(
      <AttentionPanel
        attention={attentionFrom([], {
          overview: beside,
        } as Partial<AttentionInputs>)}
        pods={beside.pods}
        podsUnread={[refusedPods]}
        nodes={[]}
        nodesKnown={false}
      />
    );
    const details = screen.getByTestId("attention-overall-details");
    expect(details).toHaveClass("truncate");
    expect(details).toHaveTextContent("(1 CreateContainerConfigError");
    const qualifier = screen.getByText("pods not counted in team-blind");
    expect(qualifier.closest(".truncate, .whitespace-nowrap")).toBeNull();
    expect(screen.getByTestId("attention-overall")).toHaveClass("flex-wrap");
  });

  /** Share said "could not be read" for a refusal, and nowhere said where. */
  it("hands Share the refusal and where, and no pods row with a total", () => {
    const attention = attentionFrom([], {
      overview,
    } as Partial<AttentionInputs>);
    const problems = attentionShare(attention, t);
    const findings =
      problems.body.type === "findings" ? problems.body.items : [];
    expect(findings.map((finding) => finding.title)).toContain(
      "Pods: refused in team-blind"
    );

    const workloads = workloadsShare(overview, t);
    const rows = workloads.body.type === "facts" ? workloads.body.rows : [];
    expect(rows.find((row) => row.label === "Pods")?.values).toEqual([
      { text: t("share", "scrNotReadable") },
      { text: "in team-blind", quiet: true },
    ]);
  });

  /** Fails if Share drops what was read, or files it as the scope's whole. */
  it("hands Share what was read and where the rest was not", () => {
    const workloads = workloadsShare(beside, t);
    const rows = workloads.body.type === "facts" ? workloads.body.rows : [];
    expect(rows.find((row) => row.label === "Jobs")?.values).toEqual([
      { text: "1 Complete", role: "neutral" },
      { text: "not read in team-blind", quiet: true },
    ]);
  });
});

describe("the Deployments tile", () => {
  /**
   * Dana: the tile said "4 Unavailable" beside a list that called one of
   * them Stalled; then everything not flagged, Progressing, Idle and Paused
   * too, sat under "Available". Fails if two words the list prints share a
   * segment, or a segment leaves the list's colour.
   */
  it("counts every Deployment under the word the list prints", () => {
    const segments = deploymentSegments(
      [
        { reason: "Idle", count: 2, podsUnread: false },
        { reason: "Stalled", count: 1, podsUnread: false },
        { reason: "Ready", count: 4, podsUnread: false },
        { reason: "Progressing", count: 1, podsUnread: false },
        { reason: "Paused", count: 1, podsUnread: false },
        { reason: "Unavailable", count: 2, podsUnread: false },
        { reason: "Degraded", count: 1, podsUnread: false },
      ],
      t
    );

    expect(segments).toEqual([
      { label: "Ready", count: 4, tone: "ok" },
      { label: "Progressing", count: 1, tone: "pending" },
      { label: "Paused", count: 1, tone: "warn" },
      { label: "Idle", count: 2, tone: "neutral" },
      { label: "Degraded", count: 1, tone: "warn" },
      { label: "Unavailable", count: 2, tone: "err" },
      { label: "Stalled", count: 1, tone: "err" },
    ]);
  });

  /**
   * The Jobs tile said Active where the Jobs list says Running, and folded
   * Retrying, Suspended and Pending into it. Fails if a list word is lost.
   */
  it("counts Jobs under the words the Jobs list prints", () => {
    expect(
      jobSegments(
        [
          { reason: "Complete", count: 3 },
          { reason: "Retrying", count: 1 },
          { reason: "Running", count: 2 },
        ],
        t
      ).map(({ label, count }) => `${count} ${label}`)
    ).toEqual(["2 Running", "1 Retrying", "3 Complete"]);
  });
});

describe("the census legend in Russian", () => {
  const flagged = (reason: string): ClusterProblem => ({
    ...problem,
    kind: "Deployment",
    reason,
    severity: "critical",
  });
  const overview = {
    counts: { deployments: 8, nodes: 1, jobs: 0 },
    pods: RUNNING,
    jobs: null,
    deployments: {
      read: [
        { reason: "Ready", count: 2 },
        { reason: "Idle", count: 2 },
        { reason: "Stalled", count: 1 },
        { reason: "Degraded", count: 2 },
        { reason: "Unavailable", count: 1 },
      ],
      complete: true,
    },
    nodes: [],
    problems: [
      flagged("Stalled"),
      flagged("Degraded"),
      flagged("Degraded"),
      flagged("Unavailable"),
    ],
    problemsTruncated: 0,
    unread: [],
  } as unknown as ClusterOverview;
  const ru: T = (section, key, values) => translate("ru", section, key, values);

  /**
   * Lena switched to Russian and the Overview census still read "1 Stalled"
   * and "2 Degraded"; then Marco's read "1 Ready  1 застрял  1 Unavailable".
   * Every rollout word is the app's verdict, none a value a Deployment's
   * status holds. Fails if any goes back to the English code.
   */
  it("words every rollout verdict in the reader's language", async () => {
    useLocaleStore.setState({ choice: "ru" });
    try {
      await wrap(<WorkloadsPanel overview={overview} scope="prod" />);
      const legend = screen.getByText("2 деградировали").parentElement;
      expect(
        Array.from(legend?.children ?? []).map((item) => item.textContent)
      ).toEqual([
        "2 готовы",
        "2 простаивают",
        "2 деградировали",
        "1 недоступен",
        "1 застрял",
      ]);
      expect(
        screen.queryByText(/Ready|Stalled|Degraded|Unavailable/)
      ).toBeNull();
    } finally {
      useLocaleStore.setState({ choice: null });
    }
  });

  /** Share draws the same segments, so it must not keep the English the screen lost. */
  it("hands Share the same words the legend draws", () => {
    const section = workloadsShare(overview, ru);
    const rows = section.body.type === "facts" ? section.body.rows : [];
    const deployments = rows.find((row) => row.label === "Deployments");
    expect(deployments?.values.map((value) => value.text)).toEqual([
      "2 готовы",
      "2 простаивают",
      "2 деградировали",
      "1 недоступен",
      "1 застрял",
    ]);
  });

  /**
   * A Job word worded by `ownStatusWord` for the badge but without a counted
   * form would print its English code in the legend beside Russian ones.
   * Fails the day that happens.
   */
  it("has a counted word for every Job word the app words", () => {
    const unworded = Object.keys(JOB).filter(
      (code) =>
        ownStatusWord(code, ru) !== undefined &&
        ownCountedWord(code, 2, ru) === undefined
    );
    expect(unworded).toEqual([]);
  });

  /** Russian counts take three forms; one form for all would print "5 застрял". */
  it.each([
    [1, "застрял"],
    [2, "застряли"],
    [5, "застряли"],
    [21, "застрял"],
  ])("agrees with %i in number", (n, word) => {
    expect(rolloutCountedWord("Stalled", n, ru)).toBe(word);
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

  /**
   * A report that dropped what was not checked would read as a clean bill,
   * and one calling a refusal a failure would disagree with the panel.
   */
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
        title: "HorizontalPodAutoscalers: refused across the cluster",
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
      pods: RUNNING,
      jobs: null,
      nodes: [],
      problems: [],
      unread: [],
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
  const panel = (attention: Attention, pods: PodComposition = RUNNING.read) =>
    wrap(
      <AttentionPanel
        attention={attention}
        pods={{ read: pods, complete: true }}
        podsUnread={[]}
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
        answered: [],
        unread: [
          {
            namespace: "net",
            code: "PERMISSION_DENIED",
            message:
              'services is forbidden: User "sam" cannot list resource "services" in API group "" in the namespace "net"',
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
    expect(unchecked).toHaveTextContent("may not list in net");
    expect(unchecked.querySelector("[title]")?.getAttribute("title")).toBe(
      'services is forbidden: User "sam" cannot list resource "services" in API group "" in the namespace "net"'
    );
    expect(screen.getByTestId("attention-summary")).not.toHaveTextContent(
      "Healthy"
    );
  });

  /**
   * Marco's Overview: `refused in team-checkout: Kubernetes API error:
   * ApiError: daemonsets.apps is forbidden: User "system:serviceaccount:…`,
   * cut mid-word. A refusal reads as the verb and the scope refused; the
   * server's sentence is on hover. Fails if the sentence is printed in the
   * row again, or a cluster-wide refusal loses its scope.
   */
  it("says what was refused and where, with the server's sentence on hover", async () => {
    const said = (resource: string, where: string) =>
      `${resource} is forbidden: User "system:serviceaccount:team-checkout:marco" cannot list resource "${resource.split(".")[0]}" in API group "${resource.split(".").slice(1).join(".")}" ${where}`;
    const daemonsets = said(
      "daemonsets.apps",
      'in the namespace "team-checkout"'
    );
    const nodes = said("nodes", "at the cluster scope");
    await panel(
      attentionFrom([], {
        overview: {
          problems: [],
          problemsTruncated: 0,
          unread: [
            {
              kind: "DaemonSet",
              namespace: "team-checkout",
              code: "PERMISSION_DENIED",
              message: daemonsets,
            },
            {
              kind: "Node",
              namespace: null,
              code: "PERMISSION_DENIED",
              message: nodes,
            },
          ],
        } as unknown as ClusterOverview,
      })
    );

    const unchecked = screen.getByTestId("attention-unchecked");
    expect(unchecked).toHaveTextContent("may not list in team-checkout");
    expect(unchecked).toHaveTextContent("may not list across the cluster");
    expect(unchecked).not.toHaveTextContent(
      /forbidden|ApiError|Kubernetes API error/
    );
    const hovers = [...unchecked.querySelectorAll("[title]")].map((at) =>
      at.getAttribute("title")
    );
    expect(hovers).toEqual(expect.arrayContaining([daemonsets, nodes]));
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
      notReady: 0,
      ready: 5,
      stuck: [],
      starting: 0,
    });

    const summary = screen.getByTestId("attention-summary");
    expect(summary).not.toHaveTextContent("Healthy");
    expect(summary).toHaveTextContent("5 of 13 pods ready");
    expect(summary).toHaveTextContent(
      "(1 CrashLoop, 3 Pending, 2 Failed, 2 Completed)"
    );
    expect(summary.querySelector(".bg-err")).not.toBeNull();
    expect(summary.querySelector(".bg-ok")).toBeNull();
  });

  /**
   * Dana's shop: "6 of 14 pods running" while kubectl had 5 ready, the
   * sixth a search pod `Running` and `0/1`, its readiness probe failing.
   * Fails if a pod up and not ready is counted with the ones serving.
   */
  it("counts a pod up and not ready apart from the ones serving", async () => {
    await panel(attentionFrom([{ ...problem, severity: "critical" }]), {
      running: 9,
      pending: 1,
      succeeded: 0,
      failed: 4,
      unknown: 0,
      crashLooping: 3,
      notReady: 1,
      ready: 5,
      stuck: [],
      starting: 0,
    });

    const summary = screen.getByTestId("attention-summary");
    expect(summary).toHaveTextContent("5 of 14 pods ready");
    expect(summary).toHaveTextContent(
      "(1 NotReady, 3 CrashLoop, 1 Pending, 4 Failed)"
    );
  });

  /**
   * Sam's Overview read "3 of 15 pods ready" while kubectl had 6 ready.
   * Fails if the line counts ready anything but the pods whose Ready
   * condition is true, as kubectl does.
   */
  it("counts ready the pods kubectl counts ready", async () => {
    await panel(attentionFrom([{ ...problem, severity: "critical" }]), {
      running: 3,
      pending: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      crashLooping: 1,
      notReady: 0,
      ready: 3,
      stuck: [],
      starting: 0,
    });

    expect(screen.getByTestId("attention-summary")).toHaveTextContent(
      "3 of 3 pods ready"
    );
  });

  /**
   * Sam's big-pull, placed and pulling its image: the Pods tile and the
   * overall line said "Pending" in amber while its page and its Deployment
   * said coming up in blue, and the Deployments tile drew Progressing grey.
   * Fails if a pod still inside its wait is counted with the ones past it,
   * or either tile draws coming up in another colour than the badges do.
   */
  it("counts a pod still inside its wait as starting, apart from Pending", async () => {
    const pods: PodComposition = {
      running: 2,
      pending: 3,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      crashLooping: 0,
      notReady: 0,
      ready: 2,
      stuck: [],
      starting: 2,
    };
    await panel(attentionFrom([{ ...problem, severity: "critical" }]), pods);

    expect(screen.getByTestId("attention-summary")).toHaveTextContent(
      "(2 Starting, 1 Pending)"
    );
    expect(
      podSegments(pods, t)
        .filter((segment) => segment.count > 0)
        .map(({ label, count, tone }) => [label, count, tone])
    ).toEqual([
      ["Running", 2, "ok"],
      ["Starting", 2, "pending"],
      ["Pending", 1, "warn"],
    ]);
    expect(
      deploymentSegments(
        [{ reason: "Progressing", count: 1, podsUnread: false }],
        t
      )[0].tone
    ).toBe("pending");
  });

  /**
   * Sam's team-checkout: "1 Pending" on the Overview for the pod its Pods
   * list and its Needs attention row call `CreateContainerConfigError`.
   * Fails if the line or the Pods tile files it under the phase.
   */
  it("names a pod held in an error by that error, not by its phase", async () => {
    const pods: PodComposition = {
      running: 2,
      pending: 1,
      succeeded: 1,
      failed: 0,
      unknown: 0,
      crashLooping: 0,
      notReady: 0,
      ready: 2,
      stuck: [{ reason: "CreateContainerConfigError", count: 1 }],
      starting: 0,
    };
    await panel(attentionFrom([{ ...problem, severity: "critical" }]), pods);

    const summary = screen.getByTestId("attention-summary");
    expect(summary).toHaveTextContent("2 of 4 pods ready");
    expect(summary).toHaveTextContent(
      "(1 CreateContainerConfigError, 1 Completed)"
    );
    expect(summary).not.toHaveTextContent("Pending");
    expect(
      podSegments(pods, t)
        .filter((segment) => segment.count > 0)
        .map(({ label, count, tone }) => [label, count, tone])
    ).toEqual([
      ["Running", 2, "ok"],
      ["CreateContainerConfigError", 1, "err"],
      ["Completed", 1, "neutral"],
    ]);
  });

  /**
   * Marco: under the Not checked heading sat a red dot with no word beside
   * it and his pod count, read as one more kind that was not checked. Fails
   * if the summary goes back under that heading or loses its label.
   */
  it("keeps the summary above the kinds not checked, with a label", async () => {
    await panel(
      attentionFrom([{ ...problem, severity: "critical" }], {
        services: {
          answered: [],
          unread: [
            {
              namespace: "team-checkout",
              code: "PERMISSION_DENIED",
              message: "services is forbidden",
            },
          ],
        },
      })
    );

    const summary = screen.getByTestId("attention-summary");
    const unchecked = screen.getByTestId("attention-unchecked");
    expect(unchecked).not.toContainElement(summary);
    expect(
      summary.compareDocumentPosition(unchecked) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(summary).toHaveTextContent(/^overall/);
    expect(summary.querySelector(".bg-err")).not.toBeNull();
  });

  /**
   * Dana: a CrashLoopBackOff and an autoscaler blind to its metrics wore the
   * same red cross. Each row takes its reader's tone, and the icon changes
   * with it. Fails if the rows are drawn in one tone again.
   */
  it("draws each row in its own reader's tone and icon", async () => {
    await panel(
      attentionFrom(
        [
          {
            ...problem,
            kind: "Pod",
            name: "checkout-1",
            reason: "CrashLoopBackOff",
            severity: "critical",
          },
        ],
        {
          autoscalers: {
            data: {
              rows: [
                {
                  autoscaler: {
                    kind: "HorizontalPodAutoscaler",
                    name: "cart",
                    namespace: "shop",
                    existence: "present",
                    facts: {
                      kind: "autoscaler",
                      minReplicas: 1,
                      maxReplicas: 5,
                      currentReplicas: 2,
                      desiredReplicas: 0,
                      metrics: [],
                      conditions: [
                        {
                          type: "ScalingActive",
                          status: "False",
                          reason: "FailedGetResourceMetric",
                          message: "failed to get cpu utilization",
                          lastTransitionTime: null,
                        },
                      ],
                      lastScaleTime: null,
                    },
                  },
                  target: {
                    kind: "Deployment",
                    name: "cart",
                    namespace: "shop",
                    existence: "notChecked",
                    facts: null,
                  },
                },
              ],
              unread: [],
            },
            error: null,
          },
        }
      )
    );

    const pod = screen.getByText("CrashLoopBackOff").closest('[role="link"]')!;
    const hpa = screen
      .getByText("FailedGetResourceMetric")
      .closest('[role="link"]')!;
    expect(pod.querySelector("svg.lucide-x.text-err")).not.toBeNull();
    expect(
      hpa.querySelector("svg.lucide-triangle-alert.text-warn")
    ).not.toBeNull();
    expect(hpa.querySelector(".text-err")).toBeNull();
  });

  /**
   * Dana read "CreateContainerCon…" in the reason column of Needs attention,
   * the one word she matches against kubectl. jsdom lays nothing out, so this
   * asserts the column's pixels: fails if the grid stops giving the longest
   * waiting reason, Init:CreateContainerConfigError, its whole width.
   */
  it("gives a reason the room of the longest waiting status", async () => {
    await panel(
      attentionFrom([
        { ...problem, kind: "Pod", reason: "CreateContainerConfigError" },
      ])
    );
    const row = screen
      .getByText("CreateContainerConfigError")
      .closest('[role="link"]')!;
    const reasonPx = Number(
      /grid-cols-\[10px_(\d+)px_/.exec(row.className)?.[1]
    );
    expect(reasonPx).toBeGreaterThanOrEqual(
      "Init:CreateContainerConfigError".length * 7.2 + 14
    );
  });

  /**
   * "FailedGetResourceM..." in a 150px column, with no way to read the
   * rest. Fails if the cut reason stops carrying its whole word on hover.
   */
  it("keeps a reason its column cuts readable on hover", async () => {
    await panel(
      attentionFrom([
        {
          ...problem,
          kind: "Pod",
          reason: "CreateContainerConfigError",
          severity: "critical",
        },
      ])
    );

    expect(screen.getByText("CreateContainerConfigError")).toHaveAttribute(
      "title",
      "CreateContainerConfigError"
    );
  });

  /**
   * Lena read "...поэтому н…" and "...никто не подхваты…" with nothing to
   * hover. Fails if a cut detail sentence stops carrying its whole text.
   */
  it("keeps a detail sentence its row cuts readable on hover", async () => {
    const sentence =
      "IngressClass traefik is served by nothing in this cluster, so nothing picks this Ingress up";
    await panel(
      attentionFrom([{ ...problem, detail: { says: "said", text: sentence } }])
    );
    expect(screen.getByTitle(sentence)).toBeInTheDocument();
  });

  /**
   * Dana: one failed CronJob run was three rows. The backend folds the
   * Job's failed pods into its row; the row and Share both say how many.
   * Fails if the count is dropped on either reader.
   */
  it("says how many failed pods a failed Job's row stands for", async () => {
    const attention = attentionFrom([
      {
        ...problem,
        kind: "Job",
        name: "reports-29853686",
        reason: "BackoffLimitExceeded",
        severity: "critical",
        foldedPods: 2,
      },
    ]);
    await panel(attention);

    expect(
      screen.getByText("BackoffLimitExceeded").closest('[role="link"]')
    ).toHaveTextContent("2 failed pods");
    const share = attentionShare(attention, t);
    expect(
      share.body.type === "findings" && share.body.items[0].detail
    ).toContain("2 failed pods");
  });

  /**
   * Sam's `web`: the age column said "Unknown" on every Service and Ingress
   * row, and its label was capitalised unlike every verdict beside it. A row
   * nothing dates gets the column's quiet dot. Fails if "Unknown" comes back
   * or the label leaves the verdicts' case.
   */
  it("draws an undated row's age as a dot, in the verdicts' own case", async () => {
    await panel(
      attentionFrom([], {
        services: {
          answered: [
            {
              namespace: "net",
              groups: [
                {
                  names: ["web"],
                  type: "ClusterIP",
                  selectorless: false,
                  ready: 0,
                  draining: 0,
                  notReady: 0,
                  unrouted: 0,
                },
              ],
            },
          ],
          unread: [],
        },
      })
    );

    const row = screen.getByText("no endpoints").closest('[role="link"]')!;
    expect(row).not.toHaveTextContent("Unknown");
    expect(row.lastElementChild).toHaveTextContent("·");
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

  /**
   * Dana: "and 3 more" was plain text, and Stalled payments sat behind it.
   * The count is a button that opens the held rows in place; what the
   * backend cut keeps its count. Fails if the count stops being reachable
   * by keyboard or opens nothing.
   */
  it("opens the rows past the cap in place from the keyboard", async () => {
    const pods = Array.from({ length: 14 }, (_, at) => ({
      ...problem,
      kind: "Pod",
      name: `api-${at}`,
      severity: "critical" as const,
    }));
    const attention = attentionFrom(pods);
    await panel({ ...attention, total: attention.total + 3 });

    const more = screen.getByRole("button", { name: "and 5 more" });
    more.focus();
    await userEvent.keyboard("{Enter}");

    expect(screen.getAllByRole("link", { name: /^Pod api-/ })).toHaveLength(14);
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
    expect(screen.getByText("and 3 more")).toBeInTheDocument();
  });
});

describe("Ingresses asking for an IngressClass the cluster does not have", () => {
  const unserved = (name: string, className: string, tls = false) =>
    ({
      name,
      namespace: "k8s-gui-test",
      className,
      rules: [],
      defaultBackend: null,
      loadBalancerIps: [],
      tlsConfigs: tls
        ? [{ hosts: [], secretName: `${name}-tls`, isCatchAll: false }]
        : [],
    }) as IngressHealthInput;

  const attention = () =>
    attentionFrom([], {
      ingresses: {
        data: {
          rows: [
            unserved("checkout", "traefik", true),
            unserved("dupe-nginx-new", "nginx"),
            unserved("expiring-demo", "traefik"),
            unserved("ghost-demo", "nginx"),
            unserved("ghost-nginx", "nginx"),
            unserved("lonely", "haproxy"),
          ],
          unread: [],
        },
        error: null,
      },
      ingressHealth: (row) =>
        ingressHealthOf({
          ingress: row,
          binding: {
            known: true,
            value: {
              requested: row.className,
              resolved: null,
              controller: null,
              viaDefault: false,
              available: [],
            },
          },
          backing: { known: true, value: new Map() },
          certificates: new Map([
            ["checkout-tls", { problem: { says: "noSecret" } } as never],
          ]),
        }),
    });

  /**
   * Sam's Overview printed "No IngressClass named nginx in this cluster, so
   * nothing picks this Ingress up" on about 20 rows. Fails if a grouped row
   * says the sentence again, if the class marker goes, or if grouping changes
   * the count the sidebar and status bar read.
   */
  it("says the missing class once per class and marks each Ingress under it with the class", async () => {
    const read = attention();
    expect(read.total).toBe(6);
    await wrap(
      <AttentionPanel
        attention={read}
        pods={RUNNING}
        podsUnread={[]}
        nodes={[]}
        nodesKnown={true}
      />
    );

    const lines = screen.getAllByTestId("attention-unserved");
    expect(lines.map((line) => line.textContent)).toEqual([
      "no controller2 Ingresses here ask for an IngressClass this cluster does not have: traefik",
      "no controller3 Ingresses here ask for an IngressClass this cluster does not have: nginx",
    ]);
    expect(
      screen.getAllByRole("img", {
        name: "No IngressClass named nginx in this cluster",
      })
    ).toHaveLength(3);
    expect(
      screen.getAllByRole("img", {
        name: "No IngressClass named traefik in this cluster",
      })
    ).toHaveLength(2);
    expect(screen.queryAllByText(/nothing picks this Ingress up/)).toHaveLength(
      1
    );
    expect(screen.getByText(/checkout-tls/)).toBeInTheDocument();
  });

  /** A Share report of the same list must group it the same way. */
  it("offers Share one finding per missing class, with the class on each Ingress", () => {
    const section = attentionShare(attention(), t);
    const items = section.body.type === "findings" ? section.body.items : [];
    const titles = items.map((item) => item.title);
    expect(titles[0]).toBe(
      "2 Ingresses here ask for an IngressClass this cluster does not have: traefik"
    );
    expect(titles[1]).toBe("no controller · traefik");
    expect(items[1]?.detail).toMatch(/checkout-tls/);
    expect(items[1]?.detail).not.toMatch(/IngressClass/);
    expect(titles).toContain("no controller");
  });
});
