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

const traffic = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useTraffic", () => ({ useTraffic: traffic }));

const { Block, WorkloadFlows } = await import("./workload-traffic");

const ISTIO: FlowSource = {
  id: "istio",
  name: "Istio",
  state: { says: "present" },
  measures: ["requests", "errors", "p50", "p95", "p99"],
  found: [],
  need: "needIstio",
  marks: true,
  nodeAgent: false,
  needsPods: true,
  grpcErrors: true,
};
const BEYLA: FlowSource = {
  ...ISTIO,
  id: "beyla",
  name: "Beyla",
  measures: ["bytes"],
  marks: false,
  nodeAgent: true,
  needsPods: false,
  grpcErrors: false,
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
  observed: Observed[] | null,
  more: Partial<TrafficReading["answer"]> = {}
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
        sides: [],
        values: MEASURES.map((measure) => set[measure] ?? null),
        reasons: [],
      })),
      reads: [],
      observed,
      coverage: [],
      podsUnread: [],
      podsFailed: null,
      cut: 0,
      ...more,
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
    expect(screen.getByText("50% errors").className).toContain("text-err");
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

  /**
   * A refused or timed-out query returns no rows for the subject, which is
   * not the source seeing none: the block says it could not be read.
   */
  it("says a source's flows could not be read where its queries failed, never that it saw none", async () => {
    const refused = {
      says: "failed" as const,
      code: "PROMETHEUS",
      message: "timed out after 20s",
    };
    await draw(
      read([ISTIO], [], [{ source: 0, pods: 2, marked: 2 }], {
        reads: [{ source: 0, measure: "requests", state: refused }],
      })
    );
    expect(screen.queryByText(/saw no flows/)).toBeNull();
    expect(
      screen.getByText(
        "Whether Istio saw flows to or from it is not known: they could not be read (timed out after 20s)."
      )
    ).toBeTruthy();
  });

  /**
   * Istio names a workload by a pod label, so with the pods of its namespace
   * unread every flow of it stays unmatched and none is its.
   */
  it("says the flows could not be found where the pods of its namespace could not be read", async () => {
    await draw(
      read([ISTIO], [], null, {
        podsUnread: [
          {
            namespace: "shop",
            code: "FORBIDDEN",
            message: "pods is forbidden",
          },
        ],
      })
    );
    expect(screen.queryByText(/saw no flows/)).toBeNull();
    expect(
      screen.getByText(
        /the pods in shop could not be read, so its flows to or from it could not be found/
      )
    ).toBeTruthy();
  });

  /** Rows from a source with one failed query are partial, and say so beside them. */
  it("says some numbers could not be read beside the rows of a source with a failed query", async () => {
    await draw(
      read([ISTIO], [["web", "cart", { requests: 4 }]], null, {
        reads: [
          {
            source: 0,
            measure: "requests",
            state: { says: "read", series: 1 },
          },
          {
            source: 0,
            measure: "p95",
            state: { says: "failed", code: "PROMETHEUS", message: "timed out" },
          },
        ],
      })
    );
    expect(
      screen.getByText("Some of Istio's numbers could not be read: timed out")
    ).toBeTruthy();
  });

  /**
   * A row with a latency and no rate, because the rate's query failed, is
   * "not read" in warning, not "none": a failed read is not a quiet pair.
   */
  it("says a row's rate was not read where its query failed, never none", async () => {
    await draw(
      read([ISTIO], [["web", "cart", { p95: 0.012 }]], null, {
        reads: [
          {
            source: 0,
            measure: "requests",
            state: { says: "failed", code: "PROMETHEUS", message: "timed out" },
          },
        ],
      })
    );
    const unread = screen.getByText("not read");
    expect(unread.className).toContain("text-warn");
    expect(screen.queryByText("none")).toBeNull();
  });

  /**
   * A workload with more pairs than a reading keeps is drawn with only the
   * busiest: the block says how many it left out, as the page does.
   */
  it("says how many flows it left out where the reading was cut", async () => {
    await draw(
      read([ISTIO], [["web", "cart", { requests: 4 }]], null, { cut: 7 })
    );
    expect(
      screen.getByText(/^Showing .*; 7 flows quieter are left out\.$/)
    ).toBeTruthy();
  });

  /**
   * A CronJob's pods, and Hubble's names, file a run's flows under the
   * CronJob: a Job asked about as itself is never any flow's end.
   */
  it("reads a Job a CronJob made as that CronJob, and says so", async () => {
    traffic.mockReset();
    traffic.mockReturnValue(read([ISTIO], [], null));
    const owner = {
      api_version: "batch/v1",
      kind: "CronJob",
      name: "backup",
      uid: "u1",
      controller: true,
    };
    const job = (owners?: (typeof owner)[]) =>
      renderWithRouter(
        <WorkloadFlows
          kind="Job"
          namespace="shop"
          name="backup-28473000"
          owners={owners}
        />,
        {
          at: "/c/prod/jobs/shop/backup-28473000",
          route: "/c/$cluster/jobs/$namespace/$name",
        }
      );
    const loading = await job(undefined);
    expect(traffic).not.toHaveBeenCalled();
    loading.unmount();
    await job([owner]);
    expect(traffic.mock.calls.at(-1)?.[0].subject).toEqual({
      namespace: "shop",
      group: "batch",
      kind: "CronJob",
      name: "backup",
    });
    expect(
      screen.getByText(
        /Flows are counted for CronJob backup, which made this Job/
      )
    ).toBeTruthy();
  });

  /**
   * A Deployment of another API group is not the built-in Deployment: with
   * no CRD here serving its group it is named, not linked to the built-in
   * object of the same name.
   */
  it("does not link a namesake of a built-in kind to the built-in object", async () => {
    const state = read([ISTIO], [["web", "cart", { requests: 1 }]], null);
    if (state.says !== "read") throw new Error("a reading");
    const namesake: FlowEnd = {
      is: "workload",
      key: {
        namespace: "shop",
        group: "example.com",
        kind: "Deployment",
        name: "web",
      },
    };
    const reading = {
      ...state.reading,
      answer: { ...state.reading.answer, ends: [namesake, end("cart")] },
    };
    await draw({ ...state, reading, rows: pairRows(reading).rows });
    expect(screen.getByText(/^web/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^web/ })).toBeNull();
  });
});
