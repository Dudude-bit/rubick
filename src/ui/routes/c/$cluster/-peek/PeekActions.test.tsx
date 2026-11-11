import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bug, Trash2 } from "lucide-react";

import { renderWithRouter } from "@/test/render";

const REASON =
  "Your access does not allow this: the cluster answers no to kubectl auth can-i patch pods --subresource=ephemeralcontainers -n team-checkout and to kubectl auth can-i create pods -n team-checkout.";

const actionsAsked = vi.hoisted(() => [] as { kind: string | null }[]);

vi.mock("../-object/useObjectActions", () => ({
  useObjectActions: (options: { kind: string | null }) => (
    actionsAsked.push(options),
    {
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
    }
  ),
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

describe("the peek of a custom resource named like a built-in kind", () => {
  /**
   * The peek handed Knative's `Service` to the actions as a bare kind, so it
   * planned the core Service's Delete and port-forward for a ksvc. Fails if
   * a CRD's object is resolved to the registry's kind of the same name.
   */
  it("asks for no built-in kind's actions", async () => {
    actionsAsked.length = 0;
    await renderWithRouter(
      <PeekActions
        target={{
          kind: "Service",
          name: "hello",
          namespace: "default",
          crd: "services.serving.knative.dev",
        }}
        detail={undefined}
        onClose={() => {}}
      />
    );
    expect(actionsAsked.at(-1)?.kind).toBeNull();

    await renderWithRouter(
      <PeekActions
        target={{ kind: "Service", name: "hello", namespace: "default" }}
        detail={undefined}
        onClose={() => {}}
      />
    );
    expect(actionsAsked.at(-1)?.kind).toBe("Service");
  });
});
