import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { FlowEnd } from "@/generated/types";
import { translate } from "@/i18n";
import {
  flowTone,
  liveRow,
  MEASURES,
  pairRows,
  type FlowSource,
} from "@/lib/traffic";
import { renderWithRouter } from "@/test/render";

vi.mock("./PolicyReadingLine", () => ({
  PolicyReadingLine: ({ from, to }: { from: FlowEnd; to: FlowEnd }) => (
    <p data-testid="policy-reading">{`${from.is} → ${to.is}`}</p>
  ),
}));

const { FlowPanel } = await import("./FlowPanel");

const end = (name: string): FlowEnd => ({
  is: "workload",
  key: { namespace: "shop", group: "apps", kind: "Deployment", name },
});

describe("a flow opened from its edge", () => {
  /**
   * A drop is said by Hubble's own reason and opens the NetworkPolicy that
   * denied it, which is the question a dropped flow asks.
   */
  it("names a drop's reason as Hubble wrote it and links the policy that denied it", async () => {
    const row = liveRow({
      from: end("web"),
      to: end("db"),
      forwarded: 0,
      dropped: 1,
      drops: [
        {
          reason: "POLICY_DENIED",
          rate: 1,
          policies: [
            {
              group: "networking.k8s.io",
              kind: "NetworkPolicy",
              namespace: "shop",
              name: "deny-all",
            },
          ],
          l7: false,
        },
      ],
      requests: null,
      errors: null,
      p50: null,
      p95: null,
      p99: null,
      protocols: [],
    });
    await renderWithRouter(
      <FlowPanel row={row} window="last minute" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(screen.getByText(/POLICY_DENIED: 1\/s/)).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "NetworkPolicy shop/deny-all",
    });
    expect(link.getAttribute("href")).toContain("networkpolicies");
    expect(screen.getByText("Hubble Relay counted:")).toBeTruthy();
  });

  /**
   * Hubble counts HTTP 5xx and a failed gRPC call answers 200: the panel
   * must not promise gRPC statuses it never read, and the cell is a floor.
   */
  it("says Hubble's errors are HTTP 5xx only, and its share over HTTP/2 a floor", async () => {
    const row = liveRow({
      from: end("web"),
      to: end("api"),
      forwarded: 2,
      dropped: 0,
      drops: [],
      requests: 10,
      errors: 0,
      p50: null,
      p95: null,
      p99: null,
      protocols: ["HTTP/2"],
    });
    await renderWithRouter(
      <FlowPanel row={row} window="last minute" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "0% of them HTTP 5xx (a failed gRPC call is answered with a 200"
    );
    expect(text).not.toContain("gRPC other than OK");
  });

  /**
   * An L7 rule's denial reaches Hubble with no reason code: said by its
   * own words, the panel does not print Hubble's DROP_REASON_UNKNOWN.
   */
  it("says a request an L7 rule denied as that, not as an unknown reason", async () => {
    const row = liveRow({
      from: end("caller"),
      to: end("web"),
      forwarded: 0,
      dropped: 2,
      drops: [
        { reason: "DROP_REASON_UNKNOWN", rate: 2, policies: [], l7: true },
      ],
      requests: null,
      errors: null,
      p50: null,
      p95: null,
      p99: null,
      protocols: [],
    });
    await renderWithRouter(
      <FlowPanel row={row} window="last minute" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(
      screen.getByText("HTTP requests an L7 rule denied: 2/s")
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("DROP_REASON_UNKNOWN");
  });

  /**
   * Calls the server's proxy did not report are in the caller's proxy's
   * report only: the row holds them and is not green, and the panel says
   * which proxy each number came from, the server's alone where it alone
   * spoke. Why the server's proxy is silent on them is not in the series, so
   * neither language says they never reached it.
   */
  it("says which proxy the numbers came from, and keeps the caller's failures in the share", async () => {
    const istio: FlowSource = {
      id: "istio",
      name: "Istio",
      state: { says: "present" },
      measures: ["requests", "errors"],
      found: [],
      need: "needIstio",
      marks: true,
      nodeAgent: false,
      needsPods: true,
      grpcErrors: true,
    };
    const row = (sides: string[], requests: number, errors: number) =>
      pairRows({
        sources: [istio],
        window: "5m",
        answer: {
          ends: [end("web"), end("api")],
          flows: [
            {
              source: 0,
              from: 0,
              to: 1,
              protocols: ["http"],
              sides,
              values: MEASURES.map((m) =>
                m === "requests" ? requests : m === "errors" ? errors : null
              ),
              reasons: [],
            },
          ],
          reads: [],
          observed: null,
          coverage: [],
          podsUnread: [],
          podsFailed: null,
          cut: 0,
        },
      }).rows[0];
    const both = row(["caller", "server"], 30, 20);
    expect(flowTone(both)).toBe("err");
    const page = await renderWithRouter(
      <FlowPanel row={both} window="last 5 minutes" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(screen.getByText(/of them errors/).className).toContain("text-err");
    expect(
      screen.getByText(
        "From the server's proxy, and the calls only the caller's proxy saw: the server's proxy did not report them."
      )
    ).toBeTruthy();
    for (const locale of ["en", "ru"] as const)
      expect(translate(locale, "traffic", "panelSideBoth")).not.toMatch(
        /before reaching|не дошли/
      );
    page.unmount();
    await renderWithRouter(
      <FlowPanel
        row={row(["server"], 10, 0)}
        window="last 5 minutes"
        onClose={() => {}}
      />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(screen.getByText("From the server's proxy.")).toBeTruthy();
  });

  /**
   * A pair Hubble sees only at L4 has no requests to show: the panel says it
   * once, where the table's cells are blank and titled the same.
   */
  it("says a pair seen only below HTTP is that, beside the flows it has", async () => {
    const row = liveRow({
      from: end("caller"),
      to: end("db"),
      forwarded: 2,
      dropped: 0,
      drops: [],
      requests: null,
      errors: null,
      p50: null,
      p95: null,
      p99: null,
      protocols: [],
    });
    await renderWithRouter(
      <FlowPanel row={row} window="last minute" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(
      screen.getByText(
        "Seen only below HTTP: requests, errors and latency are not counted for this pair."
      )
    ).toBeTruthy();
    expect(screen.getByText("2 forwarded flows/s")).toBeTruthy();
  });

  /**
   * Hubble's requests query failed while its flow events came back: the
   * pair has no requests because they were not read, not because it is
   * below HTTP, and the panel says the first.
   */
  it("says a pair's requests were not read, not that it is below HTTP, where their query failed", async () => {
    const hubble: FlowSource = {
      id: "hubble",
      name: "Hubble",
      state: { says: "present" },
      measures: ["events", "requests", "errors"],
      found: [],
      need: "needHubble",
      marks: false,
      nodeAgent: true,
      needsPods: false,
      grpcErrors: false,
    };
    const [row] = pairRows({
      sources: [hubble],
      window: "5m",
      answer: {
        ends: [end("caller"), end("db")],
        flows: [
          {
            source: 0,
            from: 0,
            to: 1,
            protocols: [],
            sides: [],
            values: MEASURES.map((m) => (m === "events" ? 2 : null)),
            reasons: [],
          },
        ],
        reads: [
          {
            source: 0,
            measure: "requests",
            state: { says: "failed", code: "PROMETHEUS", message: "timed out" },
          },
        ],
        observed: null,
        coverage: [],
        podsUnread: [],
        podsFailed: null,
        cut: 0,
      },
    }).rows;
    await renderWithRouter(
      <FlowPanel row={row} window="last 5 minutes" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(
      screen.getByText(
        "Its requests could not be read, so whether this pair is seen above HTTP is not known."
      )
    ).toBeTruthy();
    expect(screen.queryByText(/Seen only below HTTP/)).toBeNull();
  });

  /**
   * A default deny names no policy in Hubble's drop: the panel gives the
   * app's reading of the policies there, where Hubble named one its name
   * leads, and a zero of forwarded flows beside the drops is left out.
   */
  it("reads the policies itself where Hubble named none, and leaves out a zero of forwarded flows", async () => {
    const dropped = (policies: { name: string }[]) =>
      liveRow({
        from: end("intruder"),
        to: end("db"),
        forwarded: 0,
        dropped: 0.65,
        drops: [
          {
            reason: "POLICY_DENIED",
            rate: 0.65,
            l7: false,
            policies: policies.map(({ name }) => ({
              group: "cilium.io",
              kind: "CiliumNetworkPolicy",
              namespace: "shop",
              name,
            })),
          },
        ],
        requests: null,
        errors: null,
        p50: null,
        p95: null,
        p99: null,
        protocols: [],
      });
    const page = await renderWithRouter(
      <FlowPanel row={dropped([])} window="last minute" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(screen.getByTestId("policy-reading").textContent).toBe(
      "workload → workload"
    );
    expect(document.body.textContent).not.toContain("forwarded flows/s");
    page.unmount();
    await renderWithRouter(
      <FlowPanel
        row={dropped([{ name: "deny-intruder" }])}
        window="last minute"
        onClose={() => {}}
      />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(screen.queryByTestId("policy-reading")).toBeNull();
    expect(document.body.textContent).toContain("deny-intruder");
  });

  /** A policy kind of another API group no CRD here serves is named, not linked to the built-in kind of that name. */
  it("does not link a denying policy of an unknown group to the built-in NetworkPolicy", async () => {
    const row = liveRow({
      from: end("web"),
      to: end("db"),
      forwarded: 0,
      dropped: 1,
      drops: [
        {
          reason: "POLICY_DENIED",
          rate: 1,
          l7: false,
          policies: [
            {
              group: "example.com",
              kind: "NetworkPolicy",
              namespace: "shop",
              name: "lookalike",
            },
          ],
        },
      ],
      requests: null,
      errors: null,
      p50: null,
      p95: null,
      p99: null,
      protocols: [],
    });
    await renderWithRouter(
      <FlowPanel row={row} window="last minute" onClose={() => {}} />,
      { at: "/c/prod/traffic", route: "/c/$cluster/traffic" }
    );
    expect(document.body.textContent).toContain("NetworkPolicy shop/lookalike");
    expect(
      screen.queryByRole("link", { name: "NetworkPolicy shop/lookalike" })
    ).toBeNull();
  });
});
