import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";

import { en } from "@/i18n/catalogue";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useShortcutsOverlayStore } from "@/stores/shortcutsOverlayStore";
import { renderWithRouter } from "@/test/render";
import { ShortcutsOverlay } from "./ShortcutsOverlay";

const draw = (at = "/c/prod") => {
  useShortcutsOverlayStore.setState({ open: true });
  return renderWithRouter(<ShortcutsOverlay />, {
    at,
    route: "/c/$cluster/$",
  });
};

describe("the list behind ?", () => {
  /** Drawn from the table, so it is complete by construction; this holds it to that. */
  it("names every shortcut the table knows", async () => {
    await draw();
    for (const entry of SHORTCUTS) {
      expect(
        screen.getAllByText(en.shortcuts[entry.labelKey]).length,
        entry.id
      ).toBeGreaterThan(0);
    }
  });

  it("draws a chord as one key, then the other", async () => {
    await draw();
    const pods = screen.getByText(en.shortcuts.goPods).closest("li");
    expect(pods).toHaveTextContent(/g.*then.*p/);
  });

  /** The sheet was the only help there was, and it named no documentation. */
  it("links the Rubick documentation from every screen", async () => {
    await draw();
    expect(
      screen.getByRole("link", { name: /Rubick documentation/ })
    ).toHaveAttribute("href", "https://github.com/Dudude-bit/rubick#readme");
    expect(screen.queryByRole("link", { name: /Kubernetes docs/ })).toBeNull();
  });

  /** On a kind's list or one of its objects, the concept page for that kind. */
  it.each([
    ["/c/prod/pods", "Pod", "concepts/workloads/pods/"],
    [
      "/c/prod/deployments/shop/web",
      "Deployment",
      "concepts/workloads/controllers/deployment/",
    ],
  ])("links what a page is about from %s", async (at, kind, page) => {
    await draw(at);
    expect(
      screen.getByRole("link", {
        name: new RegExp(`${kind} in the Kubernetes docs`),
      })
    ).toHaveAttribute("href", `https://kubernetes.io/docs/${page}`);
  });
});
