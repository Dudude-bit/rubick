import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bug, Trash2 } from "lucide-react";

import { renderWithRouter } from "@/test/render";

const REASON =
  "Your access does not allow this: the cluster answers no to kubectl auth can-i patch pods/ephemeralcontainers -n team-checkout and to kubectl auth can-i create pods -n team-checkout.";

vi.mock("../-object/useObjectActions", () => ({
  useObjectActions: () => ({
    plan: {
      inline: [],
      menu: [
        { id: "debug", label: "Debug", icon: Bug, reason: REASON },
        { id: "delete", label: "Delete", icon: Trash2, danger: true },
      ],
    },
    busy: {},
    run: vi.fn(),
    dialogs: null,
  }),
}));

import { PeekActions } from "./PeekActions";

describe("the peek's More menu", () => {
  /**
   * Marco's Debug reason is one long line, and the menu stretched across the
   * whole 440px panel while the row menu wrapped the same words. Fails if
   * the menu loses the width the row menu is held to.
   */
  it("is held to the width of the row menu when an action's reason is long", async () => {
    await renderWithRouter(
      <PeekActions
        target={{ kind: "Pod", name: "api-0", namespace: "team-checkout" }}
        detail={undefined}
        onClose={() => {}}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /More actions/ }));
    const debug = await screen.findByRole("menuitem", { name: /Debug/ });
    expect(debug).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menu")).toHaveClass("max-w-[320px]");
  });
});
