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
});
