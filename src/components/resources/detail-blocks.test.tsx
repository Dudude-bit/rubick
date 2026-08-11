import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ConditionRows, UsageRow } from "./detail-blocks";
import type { ConditionInfo } from "@/generated/types";

const wrap = (ui: ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

const THREE_HOURS_AGO = new Date(Date.now() - 3 * 3600 * 1000).toISOString();

function condition(
  type: string,
  status: string,
  extra: Partial<ConditionInfo> = {}
): ConditionInfo {
  return {
    type,
    status,
    reason: null,
    message: null,
    lastTransitionTime: THREE_HOURS_AGO,
    ...extra,
  };
}

describe("ConditionRows", () => {
  /**
   * The pod from the screenshot: five satisfied conditions, not one of which
   * carries a message, so the detail column was five em dashes and the only
   * fact any of them had was 1300px away in a 46px column. A dash back in the
   * detail column means the row is again saying nothing.
   */
  it("says since when a condition with nothing to report has held", () => {
    wrap(
      <ConditionRows
        conditions={[
          condition("Ready", "True"),
          condition("Initialized", "True"),
        ]}
      />
    );
    expect(screen.getAllByText("for 3h")).toHaveLength(2);
    expect(screen.queryByText("—")).toBeNull();
  });

  /**
   * A node's conditions all carry a sentence, so the age has to keep a column
   * of its own — and the reader who wants the exact moment still gets it from
   * the title, which is the only place a full timestamp fits.
   */
  it("keeps the age beside a condition that has something to say", () => {
    wrap(
      <ConditionRows
        conditions={[
          condition("MemoryPressure", "False", {
            reason: "KubeletHasSufficientMemory",
            message: "kubelet has sufficient memory available",
          }),
        ]}
      />
    );
    expect(
      screen.getByText("kubelet has sufficient memory available")
    ).toBeInTheDocument();
    expect(screen.getByText("3h")).toBeInTheDocument();
    expect(screen.queryByText("for 3h")).toBeNull();
  });

  /**
   * A completed pod is the mixed list: `Ready` carries `PodCompleted` and
   * `PodScheduled` carries nothing. Printing the age in both places would put
   * the same fact on one row twice.
   */
  it("states a condition's age once, wherever that row put it", () => {
    wrap(
      <ConditionRows
        conditions={[
          condition("Ready", "False", { reason: "PodCompleted" }),
          condition("PodScheduled", "True"),
        ]}
      />
    );
    expect(screen.getAllByText("3h")).toHaveLength(1);
    expect(screen.getAllByText("for 3h")).toHaveLength(1);
  });

  /**
   * The status word survives its demotion. For a `MemoryPressure` the value
   * that means "met" is `False`, so a reader with `kubectl describe` open has
   * nothing else on the row that says which way round this condition runs.
   */
  it("prints the raw status word even where the glyph already said met", () => {
    wrap(<ConditionRows conditions={[condition("MemoryPressure", "False")]} />);
    expect(screen.getByText("False")).toBeInTheDocument();
  });

  /**
   * A controller writes about objects by name. If the row stops offering them
   * there is no way from `has timed out progressing` to the replica set that
   * timed out.
   */
  it("offers the objects a condition's message names", () => {
    wrap(
      <ConditionRows
        conditions={[
          condition("Progressing", "False", {
            reason: "ProgressDeadlineExceeded",
            message:
              'ReplicaSet "crash-demo-56588f6b8c" has timed out progressing.',
          }),
        ]}
        subject={{
          kind: "Deployment",
          name: "crash-demo",
          namespace: "k8s-gui-test",
        }}
      />
    );
    expect(
      screen.getByRole("link", { name: "ReplicaSet crash-demo-56588f6b8c" })
    ).toHaveAttribute(
      "href",
      "/replicasets/k8s-gui-test/crash-demo-56588f6b8c"
    );
  });
});

describe("UsageRow without a denominator", () => {
  it("draws no track for a workload that declares no limit", () => {
    // An empty full-width track is read as a bar at zero, not as "nothing
    // was measured" — which is how a pod with no limits came to look like
    // a pod using none of one.
    const { container } = render(
      <UsageRow label="CPU" used={48} total={null} type="cpu" />
    );
    expect(container.querySelectorAll('[style*="width"]')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/\d\s*%/);
  });

  it("draws no track when the limit is known but nothing is reporting", () => {
    const { container } = render(
      <UsageRow label="CPU" used={null} total={200} type="cpu" />
    );
    expect(container.querySelectorAll('[style*="width"]')).toHaveLength(0);
  });

  it("still draws the fill when both numbers are real", () => {
    const { container } = render(
      <UsageRow label="CPU" used={100} total={200} type="cpu" />
    );
    const fill = container.querySelector('[style*="width"]') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe("50%");
  });
});
