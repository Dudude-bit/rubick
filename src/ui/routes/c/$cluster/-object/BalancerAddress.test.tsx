import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@/components/ui/tooltip";
import { BalancerAddress } from "./BalancerAddress";

vi.mock("@/hooks/useBalancerEvidence", () => ({
  useBalancerEvidence: () => ({ known: true, assigned: 0 }),
}));

const PUBLIC_API = {
  type: "LoadBalancer",
  loadBalancerIps: [],
  ports: [
    {
      name: "http",
      port: 80,
      targetPort: "http",
      protocol: "TCP",
      nodePort: 32561,
    },
  ],
} as never;

describe("a LoadBalancer address nothing assigns, in a row", () => {
  /**
   * The Services list opened two tooltips on public-api's External IPs: a
   * wrapped one with the cause and the badge's native title with the word.
   * Fails if the native one comes back, or ours stops carrying the word a
   * narrow column may cut.
   */
  it("opens one tooltip with the word and its cause", async () => {
    render(
      <TooltipProvider>
        <BalancerAddress service={PUBLIC_API} compact />
      </TooltipProvider>
    );
    const badge = screen.getByText("nothing assigns it");
    expect(badge.closest("[title]")).toBeNull();
    await userEvent.hover(badge);
    const tips = await screen.findAllByRole("tooltip");
    const said = tips.map((tip) => tip.textContent).join("\n");
    expect(said).toContain("nothing assigns it");
    expect(said).toContain("32561");
  });

  /** The cause stayed open over the next row for 8 s after the pointer left. */
  it("closes the tooltip as soon as the pointer leaves the badge", async () => {
    render(
      <TooltipProvider>
        <BalancerAddress service={PUBLIC_API} compact />
      </TooltipProvider>
    );
    const badge = screen.getByText("nothing assigns it");
    await userEvent.hover(badge);
    await screen.findAllByRole("tooltip");
    await userEvent.unhover(badge);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});
