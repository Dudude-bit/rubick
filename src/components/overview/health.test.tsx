import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ProblemsPanel, WarningsPanel } from "./health";
import type { ClusterProblem, WarningGroup } from "@/generated/types";
import { useLocaleStore } from "@/stores/localeStore";

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
        />
        <WarningsPanel warnings={[warning]} />
      </>
    );

    expect(
      screen.getAllByRole("link", { name: "ReplicaSet meshed-demo-65d47b457f" })
    ).toHaveLength(2);
  });

  it("offers the object a warning group is about", () => {
    /** The row already printed `Deployment/meshed-demo`; it was the one
     *  naming of an object on this screen that went nowhere. */
    wrap(<WarningsPanel warnings={[warning]} />);

    expect(
      screen.getByRole("link", { name: "Deployment meshed-demo" })
    ).toHaveAttribute("href", "/deployments/k8s-gui-test/meshed-demo");
  });

  it("still renders a group whose event named no object", () => {
    /** An event whose involved object the API server did not record is a
     *  real warning that still has to be read. */
    wrap(
      <WarningsPanel
        warnings={[
          { ...warning, objectKind: null, objectName: null, namespace: null },
        ]}
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
