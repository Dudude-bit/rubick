import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const restartDeployment = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/commands", async (original) => {
  const real = await original<typeof import("@/lib/commands")>();
  return {
    commands: {
      ...real.commands,
      listApiCatalog: vi.fn(async () => ({ entries: [], unread: [] })),
      getRecentItems: vi.fn(async () => []),
      addRecentItem: vi.fn(async () => undefined),
      saveClusterPreferences: vi.fn(async () => undefined),
      getDeployment: vi.fn(async () => ({
        name: "checkout",
        namespace: "shop",
        generation: 1,
        replicas: { desired: 2, ready: 0, available: 0, updated: 2 },
        rollout: { state: "ready" },
        rolloutPlan: {
          strategy: "rolling",
          replicas: 2,
          surge: 1,
          unavailable: 0,
        },
        containers: [],
        initContainers: [],
        ownerReferences: [],
        createdAt: null,
      })),
      restartDeployment,
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

const configMapHit = {
  context: "k3d-dev",
  kind: "ConfigMap",
  group: "",
  plural: "configmaps",
  name: "kube-root-ca.crt",
  namespace: "shop",
};

const deploymentHit = {
  context: "k3d-dev",
  kind: "Deployment",
  group: "apps",
  plural: "deployments",
  name: "checkout",
  namespace: "shop",
};

const search = vi.hoisted(() => ({ hit: null as unknown }));

vi.mock("./useResourceSearch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useResourceSearch")>()),
  useResourceSearch: () => ({
    hits: [search.hit],
    clusters: [
      {
        context: "k3d-dev",
        status: "done",
        reason: null,
        message: null,
        matched: 1,
        truncated: false,
        searched: [
          { kind: "ConfigMap", group: "", plural: "configmaps" },
          { kind: "Deployment", group: "apps", plural: "deployments" },
        ],
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
  search.hit = configMapHit;
  restartDeployment.mockClear();
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

  /**
   * Ctrl+K, the Deployment, Tab, Restart: the Restart button held focus, so
   * the Enter that chose the action could be followed by one that restarted.
   * Fails if the cursor is anywhere but Cancel, or if Enter restarts.
   */
  it("opens Restart with the cursor on Cancel, so Enter restarts nothing", async () => {
    search.hit = deploymentHit;
    const user = userEvent.setup();
    await renderWithRouter(<CommandPalette />, {
      at: "/c/k3d-dev",
      route: "/c/$cluster/$",
    });
    window.dispatchEvent(new Event("command-palette-open"));
    await user.type(await screen.findByRole("combobox"), "checkout");
    await screen.findByText("checkout");
    await user.keyboard("{Tab}");
    await screen.findByText("Restart");
    await user.keyboard("restart{Enter}");

    const plan = await screen.findByTestId("restart-plan");
    const dialog = plan.closest("[role=dialog]") as HTMLElement;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      within(dialog).getByRole("button", { name: "Cancel" })
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(screen.queryByTestId("restart-plan")).toBeNull()
    );
    expect(restartDeployment).not.toHaveBeenCalled();
  });
});
