import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  FlowEnd,
  Measure,
  Observed,
  WorkloadKey,
} from "@/generated/types";
import type { TrafficState } from "@/hooks/useTraffic";
import {
  MEASURES,
  pairRows,
  type FlowSource,
  type TrafficReading,
} from "@/lib/traffic";
import { vendorLink } from "@/lib/links";
import { renderWithRouter } from "@/test/render";
import { Block } from "./workload-traffic";

const ISTIO: FlowSource = {
  id: "istio",
  name: "Istio",
  state: { says: "present" },
  measures: ["requests", "errors", "p50", "p95", "p99"],
  found: [],
  need: "needIstio",
  marks: true,
  nodeAgent: false,
};
const BEYLA: FlowSource = {
  ...ISTIO,
  id: "beyla",
  name: "Beyla",
  measures: ["bytes"],
  marks: false,
  nodeAgent: true,
};

const key = (name: string): WorkloadKey => ({
  namespace: "shop",
  group: "apps",
  kind: "Deployment",
  name,
});
const end = (name: string): FlowEnd => ({ is: "workload", key: key(name) });
const CART = key("cart");

function read(
  sources: FlowSource[],
  pairs: [string, string, Partial<Record<Measure, number>>][],
  observed: Observed[] | null
): TrafficState {
  const names = [...new Set(pairs.flatMap(([from, to]) => [from, to]))];
  const reading: TrafficReading = {
    sources,
    window: "5m",
    answer: {
      ends: names.map(end),
      flows: pairs.map(([from, to, set]) => ({
        source: 0,
        from: names.indexOf(from),
        to: names.indexOf(to),
        protocols: [],
        values: MEASURES.map((measure) => set[measure] ?? null),
        reasons: [],
      })),
      reads: [],
      observed,
      coverage: [],
      podsUnread: [],
      podsFailed: null,
      cut: 0,
    },
  };
  return {
    says: "read",
    endpoint: "prom.example.com",
    sources,
    reading,
    rows: pairRows(reading).rows,
    lastFailed: null,
  };
}

const draw = (state: TrafficState) =>
  renderWithRouter(<Block state={state} subject={CART} />, {
    at: "/c/prod/deployments/shop/cart",
    route: "/c/$cluster/deployments/$namespace/$name",
  });

describe("a workload's Traffic block", () => {
  /** No supplier, or one with no source, is no block: one line of advice per page would be a nag. */
  it("is not drawn where nothing measures flows", async () => {
    for (const state of [
      { says: "absent" },
      { says: "noSource", endpoint: "p", sources: [] },
    ] as TrafficState[]) {
      const { container, unmount } = await draw(state);
      expect(container.textContent).toBe("");
      unmount();
    }
  });

  /**
   * The block's "did not answer" is the page's: with the way to ask again,
   * or it goes on saying so after the supplier is back.
   */
  it("offers to ask a supplier that did not answer again", async () => {
    const askAgain = vi.fn();
    await draw({
      says: "unreachable",
      power: {
        state: "unreachable",
        vendor: "Prometheus",
        endpoint: "prom.example.com",
        reason: "connection refused",
        askAgain,
        asking: false,
        settings: vendorLink("prometheus", { tab: "connection" }),
      },
    });
    expect(screen.getByText(/did not answer: connection refused/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("ask-supplier-again"));
    expect(askAgain).toHaveBeenCalledTimes(1);
  });

  /** Callers and callees from the same rows the page draws, each with its number and source. */
  it("lists who calls it and whom it calls", async () => {
    await draw(
      read(
        [ISTIO],
        [
          ["web", "cart", { requests: 4, errors: 0 }],
          ["cart", "pay", { requests: 2, errors: 1 }],
        ],
        [{ source: 0, pods: 2, marked: 2 }]
      )
    );
    expect(screen.getByText("Calls it")).toBeTruthy();
    expect(screen.getByText(/^web/).textContent).toContain("shop");
    expect(screen.getByText(/^pay/)).toBeTruthy();
    expect(screen.getByText(/50% errors/)).toBeTruthy();
  });

  /**
   * A workload outside the mesh is not observed by it, which is a different
   * sentence from a meshed workload that was quiet.
   */
  it("says not observed for a workload outside the mesh and quiet for an idle one", async () => {
    const outside = await draw(
      read([ISTIO], [], [{ source: 0, pods: 3, marked: 0 }])
    );
    expect(
      screen.getByText(
        /Not observed by Istio: none of its 3 pods is in its mesh/
      )
    ).toBeTruthy();
    expect(screen.queryByText(/saw no flows/)).toBeNull();
    outside.unmount();
    await draw(read([ISTIO], [], [{ source: 0, pods: 3, marked: 3 }]));
    expect(
      screen.getByText(
        /Istio saw no flows to or from it in the last 5 minutes\./
      )
    ).toBeTruthy();
  });

  /** A node agent's silence says what it cannot see. */
  it("says a node agent sees only its nodes when it saw nothing", async () => {
    await draw(read([BEYLA], [], null));
    expect(
      screen.getByText(
        /Beyla saw no flows .* it sees only the nodes its agent runs on/
      )
    ).toBeTruthy();
  });
});
