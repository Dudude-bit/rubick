import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SETTINGS_SECTIONS } from "./settings-sections";

// Each section is stubbed down to a single recognisable line: what is
// under test is the shell, which section opens and what a search does to
// the rows, not what any one of them renders.
vi.mock("@/components/settings/ClustersSettings", () => ({
  ClustersSettings: () => <div>clusters pane</div>,
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

import { SettingsOverlay } from "./SettingsOverlay";
import { useClusterStore } from "@/stores/clusterStore";
import { useSettingsStore } from "@/stores/settingsStore";

/** The page underneath, which must not move while Settings is open. */
function Underneath() {
  const { pathname } = useLocation();
  return <div data-testid="underneath">{pathname}</div>;
}

/**
 * No settings route anywhere: the layer has to open over whatever route
 * the window is on, which is the reason it stopped being a page.
 */
function renderOver(path = "/workloads/pods") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Underneath />
        <SettingsOverlay />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function open(section: string) {
  useSettingsStore.setState({ open: true, section });
}

/** What the pane of each section says once it is open. */
const PANE_MARK: Record<string, RegExp> = {
  appearance: /Resource colouring/,
  clusters: /clusters pane/,
  registries: /registries pane/,
  diagnostics: /Nothing here needs attention|Search path/,
  about: /Automatic updates/,
};

const searchbox = () =>
  screen.getByRole("searchbox", { name: "Search settings" });

describe("SettingsOverlay", () => {
  beforeEach(() => {
    useClusterStore.setState({ currentContext: "k3d-k8s-gui-dev" });
    useSettingsStore.setState({ open: false, section: "appearance" });
  });

  describe("a section is a place you can open", () => {
    it.each(SETTINGS_SECTIONS.map((section) => section.id))(
      "opens straight into %s",
      async (id) => {
        open(id);
        renderOver();
        expect(await screen.findByText(PANE_MARK[id])).toBeVisible();
      }
    );

    it("names the open section in the pane heading", async () => {
      open("registries");
      renderOver();
      expect(
        await screen.findByRole("heading", { name: "Registries", level: 1 })
      ).toBeInTheDocument();
    });

    it("marks the open section in the nav as the current one", async () => {
      open("about");
      renderOver();
      expect(
        await screen.findByRole("button", { name: /About/ })
      ).toHaveAttribute("aria-current", "true");
    });
  });

  describe("a layer, not a page", () => {
    /**
     * Would break if Settings went back to being a route: opening it took
     * the reader off the list they were on and retitled the tab, and every
     * gate in front of the router outlet stood in front of Settings too.
     */
    it("leaves the route underneath where it was", async () => {
      open("appearance");
      renderOver("/workloads/pods");
      expect(await screen.findByText(/Resource colouring/)).toBeVisible();

      await userEvent.click(screen.getByRole("button", { name: /About/ }));
      expect(await screen.findByText(/Automatic updates/)).toBeVisible();

      expect(screen.getByTestId("underneath")).toHaveTextContent(
        "/workloads/pods"
      );
      expect(useSettingsStore.getState().section).toBe("about");
    });

    /**
     * Would break if Escape in the search box closed the layer again.
     *
     * The input has its own `stopPropagation` handler, written when Settings
     * was a page. Radix listens on the document in the capture phase, so that
     * handler never runs first: filtering the sections and pressing Escape to
     * get the full list back closed the whole of Settings instead. The test
     * above cannot see it — it fires Escape at `document.activeElement`, which
     * `onOpenAutoFocus` has parked on a nav button, never in the field.
     */
    it("clears the filter on Escape rather than closing, when typing in it", async () => {
      open("appearance");
      renderOver();
      expect(await screen.findByRole("dialog")).toBeInTheDocument();

      const box = screen.getByRole("searchbox");
      fireEvent.change(box, { target: { value: "colour" } });
      expect((box as HTMLInputElement).value).toBe("colour");

      fireEvent.keyDown(box, { key: "Escape" });

      expect(screen.queryByRole("dialog")).toBeInTheDocument();
      expect(useSettingsStore.getState().open).toBe(true);
      await waitFor(() => expect((box as HTMLInputElement).value).toBe(""));
    });

    /** And with nothing typed, Escape still closes — the ordinary way out. */
    it("still closes on Escape from the search box when it is empty", async () => {
      open("appearance");
      renderOver();
      expect(await screen.findByRole("dialog")).toBeInTheDocument();

      fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      );
    });

    it("closes on Escape", async () => {
      open("appearance");
      renderOver();
      expect(await screen.findByRole("dialog")).toBeInTheDocument();

      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      );
      expect(useSettingsStore.getState().open).toBe(false);
    });

    it("toggles with the preferences shortcut from any screen", async () => {
      renderOver();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: ",", ctrlKey: true });
      expect(await screen.findByRole("dialog")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: ",", metaKey: true });
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      );
    });

    it("lands focus on the open section rather than the search box", async () => {
      open("about");
      renderOver();
      const about = await screen.findByRole("button", { name: /About/ });
      await waitFor(() => expect(about).toHaveFocus());
    });
  });

  describe("search filters rows, not sections", () => {
    it("hides the rows that do not match and keeps the ones that do", async () => {
      const user = userEvent.setup();
      open("appearance");
      renderOver();
      await user.type(searchbox(), "colouring");

      await waitFor(() => expect(screen.getByText("Theme")).not.toBeVisible());
      expect(screen.getByText("Resource colouring")).toBeVisible();
    });

    it("says how many settings matched in the section you are in", async () => {
      const user = userEvent.setup();
      open("appearance");
      renderOver();
      await user.type(searchbox(), "colouring");

      expect(await screen.findByText(/1 setting matches/)).toBeInTheDocument();
    });

    // The other spelling is the whole reason a row carries keywords: the
    // app says "colouring" everywhere and half its readers type "color".
    it("finds a row by a word it does not print", async () => {
      const user = userEvent.setup();
      open("appearance");
      renderOver();
      await user.type(searchbox(), "color");

      await waitFor(() =>
        expect(screen.getByText("Resource colouring")).toBeVisible()
      );
      expect(screen.getByText("Theme")).not.toBeVisible();
    });

    it("counts the sections the reader is not standing in", async () => {
      const user = userEvent.setup();
      open("appearance");
      renderOver();
      await user.type(searchbox(), "tauri");

      // About is not the open section, so the only way its one match can
      // be counted is that a query mounts every section.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "About, 1 matching" })
        ).toBeInTheDocument()
      );
      // ...and the section holding nothing says so rather than going blank.
      expect(
        screen.getByRole("button", { name: "Registries, 0 matching" })
      ).toBeInTheDocument();
    });

    it("admits when a query matches nothing in the open section", async () => {
      const user = userEvent.setup();
      open("appearance");
      renderOver();
      await user.type(searchbox(), "zzzznotasetting");

      expect(
        await screen.findByText(/nothing here matches/)
      ).toBeInTheDocument();
    });
  });
});

describe("what a filter belongs to", () => {
  /**
   * Would break if the query outlived the screen again.
   *
   * The search provider has to sit above the dialog root so the Escape handler
   * on the content can read the query — which also means it never unmounts
   * while the app is running. Closing with a filter typed and reopening then
   * landed on a section filtered by something typed minutes ago, most rows
   * hidden and the captions gone, with the stale text in the box the only clue.
   *
   * The close and the reopen happen on ONE mount, deliberately: unmounting the
   * tree resets the provider whatever the code does, and a test that did that
   * passed against this fix deleted.
   */
  it("is forgotten when the layer closes", async () => {
    open("appearance");
    renderOver();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "123" },
    });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(
      "123"
    );

    act(() => useSettingsStore.setState({ open: false }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );

    act(() => useSettingsStore.setState({ open: true, section: "appearance" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });
});
