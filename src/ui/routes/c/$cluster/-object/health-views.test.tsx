import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@/components/ui/tooltip";
import { translate } from "@/i18n";
import { serviceHealthWords } from "@/lib/service-health";
import { ROLE_TEXT } from "@/lib/status-role";
import { VerdictBadge } from "./health-views";

const NO_ENDPOINTS = {
  code: "NoEndpoints",
  label: "no endpoints",
  role: "err" as const,
  reason:
    "No container declares the port the Service asks for (targetPort: web), so nothing is published",
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

describe("a Service's verdict whose pods were not read", () => {
  /**
   * The Services list, the peek and the page draw one badge each from this,
   * and Marco's ledger wore the fault's red X there. Fails if the badge drops
   * the verdict's own mark or its neutral colour.
   */
  it("wears the EyeOff mark in a neutral colour", () => {
    const verdict = serviceHealthWords(
      {
        state: "podsUnread",
        published: {
          ready: 0,
          draining: 0,
          notReady: 1,
          unrouted: 0,
          stop: {
            reason: "noneReady",
            service: {
              kind: "Service",
              name: "ledger",
              namespace: "team-blind",
              existence: "present",
              facts: null,
            },
            selector: "app=ledger",
            pods: 1,
            why: "podsUnread",
          },
        },
      },
      (section, key, values) => translate("en", section, key, values)
    );
    render(<VerdictBadge verdict={verdict} />);
    const badge = screen.getByText("none ready");
    expect(badge).toHaveClass(ROLE_TEXT.neutral);
    expect(badge.querySelector("svg")).toHaveClass("lucide-eye-off");
  });
});
