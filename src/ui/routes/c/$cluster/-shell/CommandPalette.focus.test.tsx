import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/commands", async (original) => {
  const real = await original<typeof import("@/lib/commands")>();
  return {
    commands: {
      ...real.commands,
      listApiCatalog: vi.fn(async () => ({ entries: [], unread: [] })),
      getRecentItems: vi.fn(async () => []),
      addRecentItem: vi.fn(async () => undefined),
      saveClusterPreferences: vi.fn(async () => undefined),
      getConfigmap: vi.fn(async () => ({
        name: "kube-root-ca.crt",
        namespace: "shop",
        dataKeys: ["ca.crt"],
        labels: {},
        annotations: {},
      })),
    },
  };
});

const hit = {
  context: "k3d-dev",
  kind: "ConfigMap",
  group: "",
  plural: "configmaps",
  name: "kube-root-ca.crt",
  namespace: "shop",
};

vi.mock("./useResourceSearch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useResourceSearch")>()),
  useResourceSearch: () => ({
    hits: [hit],
    clusters: [
      {
        context: "k3d-dev",
        status: "done",
        reason: null,
        message: null,
        matched: 1,
        truncated: false,
        searched: [{ kind: "ConfigMap", group: "", plural: "configmaps" }],
        unreadable: [],
        loading: [],
      },
    ],
    isSearching: false,
    error: null,
  }),
}));

import { CommandPalette } from "./CommandPalette";
import { renderWithRouter } from "@/test/render";
import { useClusterStore } from "@/stores/clusterStore";

beforeEach(() => {
  useClusterStore.setState({
    currentContext: "k3d-dev",
    currentNamespace: "",
    isConnected: true,
  });
});

describe("a dialog the palette opens", () => {
  /**
   * Ctrl+K, the ConfigMap, Tab, Delete: the confirmation has to take the
   * name typed next, as it does from every other opener. Fails if the
   * cursor is anywhere but the type-the-name field.
   */
  it("puts the cursor in Delete's type-the-name field", async () => {
    const user = userEvent.setup();
    await renderWithRouter(<CommandPalette />, {
      at: "/c/k3d-dev",
      route: "/c/$cluster/$",
    });
    window.dispatchEvent(new Event("command-palette-open"));
    await user.type(await screen.findByRole("combobox"), "kube-root");
    await screen.findByText("kube-root-ca.crt");
    await user.keyboard("{Tab}");
    await screen.findByText("Delete");
    await user.keyboard("delete{Enter}");

    const dialog = await screen.findByRole("alertdialog");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const field = within(dialog).getByRole("textbox");
    expect(field).toHaveFocus();
    await user.keyboard("k");
    expect(field).toHaveValue("k");
  });
});
