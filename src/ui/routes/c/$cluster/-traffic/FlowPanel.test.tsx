import { screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import type { FlowEnd } from "@/generated/types";
import { liveRow } from "@/lib/traffic";
import { renderWithRouter } from "@/test/render";
import { FlowPanel } from "./FlowPanel";

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
});
