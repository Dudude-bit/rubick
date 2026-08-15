import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SETTINGS_SECTIONS } from "@/components/settings/settings-sections";

// ----- Mocks -----

// Each section is stubbed down to a single recognisable line: what is
// under test is the shell — which section a URL opens and what a search
// does to the rows — not what any one of them renders.
vi.mock("@/components/settings/ClustersSettings", () => ({
  ClustersSettings: () => <div>clusters pane</div>,
}));
vi.mock("@/components/settings/IntegrationsSettings", () => ({
  IntegrationsSettings: () => <div>integrations pane</div>,
}));
// About is left real: its rows are what the cross-section count test
// needs something to count.
vi.mock("@/components/registry/RegistrySettings", () => ({
  RegistrySettings: () => <div>registries pane</div>,
}));
vi.mock("@/lib/commands", () => ({
  commands: {
    getAppInfo: vi.fn(async () => ({
      version: "2.1.0",
      tauriVersion: "2.0.0",
    })),
    getCurrentContext: vi.fn(async () => "k3d-k8s-gui-dev"),
  },
}));

import { Settings } from "./Settings";
import { useClusterStore } from "@/stores/clusterStore";

// ----- Harness -----

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/*" element={<Settings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** What the pane of each section says once it is open. */
const PANE_MARK: Record<string, RegExp> = {
  appearance: /Resource colouring/,
  clusters: /clusters pane/,
  integrations: /integrations pane/,
  registries: /registries pane/,
  diagnostics: /Nothing here needs attention|Search path/,
  about: /Automatic updates/,
};

describe("Settings", () => {
  beforeEach(() => {
    useClusterStore.setState({ currentContext: "k3d-k8s-gui-dev" });
  });

  describe("a section is a place you can link to", () => {
    // If this fails, a settings section has stopped being reachable by
    // URL — which is the one thing the split was for. Three places in
    // the app link to a particular section, and the nav's own entries
    // are real links that a middle click opens in a tab.
    it.each(SETTINGS_SECTIONS.map((section) => section.id))(
      "opens /settings/%s straight into that section",
      async (id) => {
        renderAt(`/settings/${id}`);
        expect(await screen.findByText(PANE_MARK[id])).toBeVisible();
      }
    );

    it("names the open section in the pane heading", async () => {
      renderAt("/settings/registries");
      expect(
        await screen.findByRole("heading", { name: "Registries", level: 1 })
      ).toBeInTheDocument();
    });

    it("marks the open section in the nav as the current page", async () => {
      renderAt("/settings/about");
      const link = await screen.findByRole("link", { name: /About/ });
      expect(link).toHaveAttribute("aria-current", "page");
      expect(link).toHaveAttribute("href", "/settings/about");
    });
  });

  describe("landing without a section", () => {
    it("sends a bare /settings to Appearance rather than an empty pane", async () => {
      renderAt("/settings");
      expect(await screen.findByText(/Resource colouring/)).toBeVisible();
    });

    // An unmatched child route inside the layout renders nothing at all,
    // so a typo would blank the page instead of admitting it.
    it("sends an unknown section to Appearance rather than a blank pane", async () => {
      renderAt("/settings/nonsense");
      expect(await screen.findByText(/Resource colouring/)).toBeVisible();
    });
  });

  describe("search filters rows, not sections", () => {
    it("hides the rows that do not match and keeps the ones that do", async () => {
      const user = userEvent.setup();
      renderAt("/settings/appearance");
      await user.type(
        screen.getByRole("searchbox", { name: "Search settings" }),
        "colouring"
      );

      await waitFor(() => expect(screen.getByText("Theme")).not.toBeVisible());
      expect(screen.getByText("Resource colouring")).toBeVisible();
    });

    it("says how many settings matched in the section you are in", async () => {
      const user = userEvent.setup();
      renderAt("/settings/appearance");
      await user.type(
        screen.getByRole("searchbox", { name: "Search settings" }),
        "colouring"
      );

      expect(await screen.findByText(/1 setting matches/)).toBeInTheDocument();
    });

    // The other spelling is the whole reason a row carries keywords: the
    // app says "colouring" everywhere and half its readers type "color".
    it("finds a row by a word it does not print", async () => {
      const user = userEvent.setup();
      renderAt("/settings/appearance");
      await user.type(
        screen.getByRole("searchbox", { name: "Search settings" }),
        "color"
      );

      await waitFor(() =>
        expect(screen.getByText("Resource colouring")).toBeVisible()
      );
      expect(screen.getByText("Theme")).not.toBeVisible();
    });

    it("counts the sections the reader is not standing in", async () => {
      const user = userEvent.setup();
      renderAt("/settings/appearance");
      await user.type(
        screen.getByRole("searchbox", { name: "Search settings" }),
        "tauri"
      );

      // About is not the open section, so the only way its one match can
      // be counted is that a query mounts every section.
      await waitFor(() =>
        expect(
          screen.getByRole("link", { name: "About, 1 matching" })
        ).toBeInTheDocument()
      );
      // ...and the section holding nothing says so rather than going blank.
      expect(
        screen.getByRole("link", { name: "Registries, 0 matching" })
      ).toBeInTheDocument();
    });

    it("admits when a query matches nothing in the open section", async () => {
      const user = userEvent.setup();
      renderAt("/settings/appearance");
      await user.type(
        screen.getByRole("searchbox", { name: "Search settings" }),
        "zzzznotasetting"
      );

      expect(
        await screen.findByText(/nothing here matches/)
      ).toBeInTheDocument();
    });
  });

  describe("integrations with no cluster", () => {
    it("says it cannot answer rather than showing an empty list", async () => {
      useClusterStore.setState({ currentContext: null });
      renderAt("/settings/integrations");

      expect(
        await screen.findByText(/No cluster connected/)
      ).toBeInTheDocument();
      expect(screen.queryByText("integrations pane")).not.toBeInTheDocument();
    });
  });
});
