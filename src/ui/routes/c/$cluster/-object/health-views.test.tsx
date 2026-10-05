import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@/components/ui/tooltip";
import { VerdictBadge } from "./health-views";

const NO_ENDPOINTS = {
  code: "NoEndpoints",
  label: "no endpoints",
  role: "err" as const,
  reason:
    "No container declares the port it asks for (targetPort: web), so nothing is published",
};

describe("a verdict badge in a row", () => {
  /**
   * The Services list opened two tooltips on one badge: ours with the cause
   * and the badge's native title under it. Fails if the native one comes
   * back, or if ours stops carrying the verdict a narrow column may cut.
   */
  it("opens one tooltip carrying the whole verdict and its cause", async () => {
    render(
      <TooltipProvider>
        <VerdictBadge verdict={NO_ENDPOINTS} compact />
      </TooltipProvider>
    );
    const badge = screen.getByText("no endpoints");
    expect(badge.closest("[title]")).toBeNull();
    await userEvent.hover(badge);
    const tips = await screen.findAllByRole("tooltip");
    const said = tips.map((tip) => tip.textContent).join("\n");
    expect(said).toContain("no endpoints");
    expect(said).toContain("so nothing is published");
  });

  /** Without a tooltip of its own the badge keeps its hover, which is all a cut word has. */
  it("keeps the badge's own hover where nothing else carries the word", () => {
    render(
      <VerdictBadge verdict={{ ...NO_ENDPOINTS, reason: null }} compact />
    );
    expect(screen.getByText("no endpoints")).toHaveAttribute(
      "title",
      "no endpoints"
    );
  });
});
