import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ContextInfo } from "@/generated/types";

const setKubeconfigPath = vi.fn(async (_path: string) => undefined);
const listContexts = vi.fn(async (): Promise<ContextInfo[]> => CONTEXTS);

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

vi.mock("@/lib/commands", () => ({
  commands: {
    listContexts: () => listContexts(),
    getCurrentContext: vi.fn(async () => "k3d-dev"),
    getClusterPreferences: vi.fn(async () => ({ lastContext: null })),
    listContextBindings: vi.fn(async () => [
      { contextName: "gke-shop", gcpProfile: "deploy", azureProfile: null },
    ]),
    locateBinaries: vi.fn(async (names: string[]) =>
      names.map((name) => ({
        name,
        path: name === "kubelogin" ? null : `/usr/local/bin/${name}`,
      }))
    ),
    getKubeconfigPath: vi.fn(async () => null),
    getKubeconfigSource: vi.fn(async () => ({
      candidates: [
        { path: "/home/u/.kube/config", exists: true, origin: "default" },
      ],
      kubeconfig_env: null,
      counts: { contexts: 4, clusters: 4, users: 4 },
      error: null,
    })),
    setKubeconfigPath: (path: string) => setKubeconfigPath(path),
    clearKubeconfigPath: vi.fn(async () => undefined),
    getCliPaths: vi.fn(async () => ({})),
    listGcpProfiles: vi.fn(async () => [{ name: "deploy", profile: {} }]),
    listAzureProfiles: vi.fn(async () => []),
    checkHelmAvailability: vi.fn(async () => ({
      available: false,
      version: null,
      error: null,
      path: null,
      searchedPaths: [],
    })),
    checkKubectlAvailability: vi.fn(async () => ({
      available: true,
      version: "v1.31.0",
      error: null,
      path: "/usr/local/bin/kubectl",
      searchedPaths: [],
    })),
  },
}));

import { ClustersSettings } from "./ClustersSettings";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * One of each shape the screen has to describe: a client certificate, a
 * plugin that is installed, a plugin that is not, and a user entry the
 * app cannot classify.
 */
const CONTEXTS: ContextInfo[] = [
  {
    name: "k3d-dev",
    cluster: "k3d-dev",
    user: "admin@k3d-dev",
    namespace: null,
    is_current: true,
    server: "https://0.0.0.0:6443",
    exec_command: null,
    auth: { kind: "clientCertificate", source: null },
  },
  {
    name: "gke-shop",
    cluster: "gke-shop",
    user: "gke-shop",
    namespace: null,
    is_current: false,
    server: "https://34.76.11.208",
    exec_command: "gke-gcloud-auth-plugin",
    auth: { kind: "exec" },
  },
  {
    name: "aks-staging",
    cluster: "aks-staging",
    user: "aks-staging",
    namespace: null,
    is_current: false,
    server: "https://staging.azmk8s.io",
    exec_command: "kubelogin get-token --server-id abc",
    auth: { kind: "exec" },
  },
  {
    name: "mystery",
    cluster: "mystery",
    user: "mystery",
    namespace: null,
    is_current: false,
    server: "https://mystery.example.com",
    exec_command: null,
    auth: { kind: "unrecognised" },
  },
];

function renderPane() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ClustersSettings />
    </QueryClientProvider>
  );
}

describe("Clusters settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listContexts.mockResolvedValue(CONTEXTS);
    setKubeconfigPath.mockResolvedValue(undefined);
    useClusterStore.setState({ currentContext: "k3d-dev", isConnected: true });
  });

  describe("every row says how it authenticates", () => {
    // If this fails the screen has gone back to listing contexts without
    // saying what each one needs to connect — which is the whole reframe.
    // A row that cannot be classified must say so rather than pick one:
    // a confident wrong sentence here is worse than the form it replaced.
    it("names the mechanism, the plugin, and admits when it cannot tell", async () => {
      const { container } = renderPane();
      await screen.findByText(/Client certificate/);
      const said = container.textContent?.replace(/\s+/g, " ") ?? "";

      expect(said).toContain("Client certificate, embedded in the file");
      expect(said).toContain("Runs gke-gcloud-auth-plugin for a token.");
      expect(said).toContain("Runs kubelogin for a token.");
      expect(said).toContain(
        "The file does not say how this context authenticates"
      );
    });

    // The file already knows the binary is absent. Learning it by pressing
    // connect and reading an error is the failure this replaced.
    it("blocks the row whose plugin is not on PATH, and only that row", async () => {
      renderPane();

      expect(await screen.findByText("cannot connect")).toBeVisible();
      expect(
        screen.getByText(/is not on the PATH this app sees/)
      ).toBeInTheDocument();
      // The plugin that is installed is not marked: a mark only where it
      // changes what you do.
      expect(screen.getAllByText("cannot connect")).toHaveLength(1);
    });

    it("shows the bound cloud profile on the row that uses it", async () => {
      renderPane();
      expect(
        await screen.findByRole("button", { name: /GCP profile deploy/ })
      ).toBeVisible();
    });
  });

  describe("a path applies without a Save button", () => {
    // Every other setting in the app applies the moment it changes. If a
    // Save button comes back, or leaving the field stops committing, this
    // pane is once again the one place that asks twice.
    it("commits the kubeconfig path when the field loses focus", async () => {
      const user = userEvent.setup();
      renderPane();

      await user.click(
        await screen.findByRole("button", { name: "Use another file" })
      );
      const field = screen.getByRole("textbox", { name: "Kubeconfig file" });
      await user.type(field, "/tmp/other-kubeconfig");
      await user.tab();

      await waitFor(() =>
        expect(setKubeconfigPath).toHaveBeenCalledWith("/tmp/other-kubeconfig")
      );
      expect(
        screen.queryByRole("button", { name: /^Save/ })
      ).not.toBeInTheDocument();
    });

    it("offers no Save anywhere on the pane", async () => {
      renderPane();
      await screen.findByText(/Client certificate/);
      expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    });
  });
});
