import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { CountBlock } from "./workload-overview";
import { Composition } from "./detail-blocks";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import type { ObjectFacts, ResourceConnections } from "@/generated/types";

const subject = {
  kind: "StatefulSet",
  name: "stateful-demo",
  namespace: "k8s-gui-test",
  existence: "present" as const,
  facts: null,
};

function conns(...governing: ObjectFacts[]): ResourceConnections {
  return {
    subject,
    edges: governing.map((facts, at) => ({
      from: {
        kind:
          facts.kind === "autoscaler"
            ? "HorizontalPodAutoscaler"
            : "PodDisruptionBudget",
        name: facts.kind === "autoscaler" ? `hpa-${at}` : `pdb-${at}`,
        namespace: "k8s-gui-test",
        existence: "present" as const,
        facts,
      },
      to: subject,
      relation: { verb: "governs" as const, selector: null },
    })),
    stops: [],
    published: [],
    notLookedAt: [],
  };
}

const autoscaler = (
  over: Partial<Extract<ObjectFacts, { kind: "autoscaler" }>> = {}
) =>
  ({
    kind: "autoscaler",
    minReplicas: 1,
    maxReplicas: 3,
    currentReplicas: 3,
    desiredReplicas: 3,
    metrics: [
      { name: "cpu", source: "resource", target: "80%", current: "4%" },
    ],
    conditions: [],
    lastScaleTime: null,
    ...over,
  }) as ObjectFacts;

const budget = (over: Partial<Extract<ObjectFacts, { kind: "budget" }>> = {}) =>
  ({
    kind: "budget",
    minAvailable: "1",
    maxUnavailable: null,
    disruptionsAllowed: 0,
    currentHealthy: 1,
    desiredHealthy: 1,
    expectedPods: 1,
    conditions: [],
    ...over,
  }) as ObjectFacts;

/** Only `data` is read, and a real query here would need a whole client. */
const query = (data: ResourceConnections | undefined) =>
  ({ data }) as ConnectionsQuery;

function renderBlock(governance?: ConnectionsQuery) {
  return render(
    <MemoryRouter>
      <CountBlock title="Replicas" subject="what runs" governance={governance}>
        <Composition
          total={3}
          label="replicas wanted"
          segments={[{ label: "ready", count: 3, tone: "ok" }]}
        />
      </CountBlock>
    </MemoryRouter>
  );
}

describe("CountBlock", () => {
  it("renders no Set by row for a workload nothing scales", () => {
    renderBlock(query(conns()));

    expect(screen.queryByText("Set by")).toBeNull();
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.queryByText("A drain waits")).toBeNull();
    // The common case is still a bar and its legend, not an empty block.
    expect(screen.getByText("replicas wanted")).toBeInTheDocument();
  });

  it("renders no rows at all before the neighbourhood has answered", () => {
    renderBlock(query(undefined));

    expect(screen.queryByText("Set by")).toBeNull();
    expect(screen.getByText("replicas wanted")).toBeInTheDocument();
  });

  it("lets the bar own the count — the autoscaler never restates it", () => {
    renderBlock(query(conns(autoscaler())));

    expect(screen.getByText("Set by")).toBeInTheDocument();
    // `3 running · 3 wanted` is the same number the bar above it is drawing.
    expect(screen.queryByText(/running/)).toBeNull();
    expect(screen.queryByText(/wanted/)).not.toBe(null);
    expect(screen.queryByText(/3 wanted/)).toBeNull();
    // Exactly one element states the count itself.
    expect(screen.getAllByText("3")).toHaveLength(1);
  });

  it("keeps the autoscaler's range and its reading", () => {
    renderBlock(query(conns(autoscaler({ lastScaleTime: null }))));

    expect(screen.getByText(/1 to 3 replicas/)).toBeInTheDocument();
    expect(screen.getByText("cpu")).toBeInTheDocument();
    expect(screen.getByText(/against 80%/)).toBeInTheDocument();
  });

  it("reduces a budget that is doing its job to one clause", () => {
    renderBlock(query(conns(budget())));

    expect(screen.getByText("A drain waits")).toBeInTheDocument();
    expect(
      screen.getByText(/keeps at least 1 available — no disruption allowed/)
    ).toBeInTheDocument();
    // The three-line paragraph explaining a healthy state is what went.
    expect(screen.queryByText(/which is the budget doing its job/)).toBeNull();
  });

  it("keeps the sentence for a budget below its own floor", () => {
    renderBlock(query(conns(budget({ currentHealthy: 1, desiredHealthy: 2 }))));

    expect(
      screen.getByText(/is below its own floor — 1 healthy, 2 required/)
    ).toBeInTheDocument();
  });
});
