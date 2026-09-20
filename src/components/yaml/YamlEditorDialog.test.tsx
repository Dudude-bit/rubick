/**
 * The two facts the interception lives or dies by.
 *
 * One test fails if an ordinary save ever grows a warning, and one fails if a
 * delivered save ever stops carrying one. They are a pair on purpose: each is
 * the other's cost. A warning nobody sees is worthless, and a warning everyone
 * sees is worse than worthless, because it teaches the reader to click through
 * the one that mattered.
 *
 * Everything is driven through the real store, the real capability lookup and
 * the real Argo resolver — only the cluster is a fixture. A test that mocked
 * `useDelivery` would pass with the interception wired to nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";

import { useYamlEditorStore } from "@/stores/yamlEditorStore";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";

const detectInClusterExtensions = vi.fn();
const listCustomResources = vi.fn();
const applyManifest = vi.fn();
/** The neighbourhood the dialog asks about, per test. */
let connections: () => { object: null; edges: unknown[] } = () => ({
  object: null,
  edges: [],
});

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => detectInClusterExtensions(),
    listCustomResources: (...args: unknown[]) => listCustomResources(...args),
    applyManifest: (...args: unknown[]) => applyManifest(...args),
    getResourceConnections: async () => connections(),
    getYamlHistory: async () => [],
    addYamlHistoryEntry: async () => {},
  },
}));

// CodeMirror wants a layout jsdom does not have, and none of this is about
// the text surface: the buffer is set through the store instead.
vi.mock("./YamlEditor", () => ({
  YamlEditor: ({ value }: { value: string }) => <pre>{value}</pre>,
}));
vi.mock("./YamlDiffViewer", () => ({
  YamlDiffViewer: () => <div data-testid="diff" />,
}));

const { YamlEditorDialog } = await import("./YamlEditorDialog");

const DEPLOYMENT = (labels: string[]) =>
  [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: api",
    "  namespace: shop",
    ...(labels.length > 0 ? ["  labels:", ...labels] : []),
    "spec:",
    "  replicas: 2",
    "",
  ].join("\n");

const LABELLED = DEPLOYMENT(["    argocd.argoproj.io/instance: shop"]);
const PLAIN = DEPLOYMENT([]);

/** An Argo Application, with or without this Deployment in its inventory. */
function application(listsTheDeployment: boolean) {
  return {
    name: "shop",
    namespace: "argocd",
    uid: "u",
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    createdAt: null,
    labels: {},
    annotations: {},
    ownerReferences: [],
    spec: {
      project: "prod",
      source: { repoURL: "https://github.com/acme/infra", path: "envs/prod" },
      syncPolicy: { automated: { selfHeal: true } },
    },
    status: {
      sync: { status: "Synced", revision: "a3f21c9" },
      health: { status: "Healthy" },
      resources: listsTheDeployment
        ? [
            {
              group: "apps",
              kind: "Deployment",
              namespace: "shop",
              name: "api",
            },
          ]
        : [],
    },
  };
}

async function openWith(yamlText: string) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <TooltipProvider>
          <YamlEditorDialog />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  await useYamlEditorStore.getState().openEditor({
    title: "Edit Deployment: api",
    resourceKey: { kind: "Deployment", name: "api", namespace: "shop" },
    fetchYaml: async () => yamlText,
  });
  // An edit, because "Apply" with nothing changed is not the case at issue.
  useYamlEditorStore
    .getState()
    .setEditedContent(yamlText.replace("replicas: 2", "replicas: 4"));
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
  connections = () => ({ object: null, edges: [] });
  useYamlEditorStore.getState().closeEditor();
  applyManifest.mockResolvedValue({
    success: true,
    stdout: "deployment.apps/api configured",
    stderr: "",
    exit_code: 0,
  });
  detectInClusterExtensions.mockResolvedValue([
    { id: "argocd", installed: true, version: null },
  ]);
  listCustomResources.mockResolvedValue([application(true)]);
});

const { useClusterStore } = await import("@/stores/clusterStore");

// The detection scan is gated on a standing connection now — these tests
// exercise what detection hands out, so the gate is opened for them.
beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "test" });
});

describe("applying an edited manifest", () => {
  /**
   * The load-bearing one. Most objects on most clusters are delivered by
   * nothing, and the interception has to cost them exactly zero: the same
   * confirmation, the same word on the button, the same number of clicks.
   */
  it("does not tax a save nothing delivers", async () => {
    const user = await openWith(PLAIN);

    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(await screen.findByText("Apply Changes?")).toBeInTheDocument();
    expect(screen.queryByText(/will undo this/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Apply anyway/ })
    ).not.toBeInTheDocument();

    const confirm = screen
      .getAllByRole("button", { name: /^Apply$/ })
      .at(-1) as HTMLElement;
    await user.click(confirm);
    await waitFor(() => expect(applyManifest).toHaveBeenCalledTimes(1));
  });

  it("says who will undo it, and where the change belongs, before applying", async () => {
    const user = await openWith(LABELLED);

    // The quiet mark, beside the editor's own description — the same one the
    // page header carries, on a modal that covers that header.
    expect(await screen.findByText(/Argo CD · shop/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    // The title states it and the lead repeats it in the sentence it heads.
    expect(await screen.findAllByText(/Argo CD will undo this/)).toHaveLength(
      2
    );
    expect(screen.getByText(/envs\/prod/)).toBeInTheDocument();

    // It tells; it does not block.
    await user.click(screen.getByRole("button", { name: /Apply anyway/ }));
    await waitFor(() => expect(applyManifest).toHaveBeenCalledTimes(1));
  });

  it("calls a stale label stale instead of promising a revert", async () => {
    listCustomResources.mockResolvedValue([application(false)]);
    const user = await openWith(LABELLED);

    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(
      await screen.findByText(/Nothing is applying this object/)
    ).toBeInTheDocument();
    expect(screen.getByText(/does not list it/)).toBeInTheDocument();
    expect(screen.queryByText(/will undo this/)).not.toBeInTheDocument();
    // No consequence to override, so no "anyway".
    expect(
      screen.queryByRole("button", { name: /Apply anyway/ })
    ).not.toBeInTheDocument();
  });
});

describe("applying on critical infrastructure", () => {
  beforeEach(() => {
    useClusterIdentityStore.setState({ marks: {} });
    useClusterIdentityStore.getState().setCritical("test", true);
  });

  afterEach(() => {
    useClusterIdentityStore.setState({ marks: {} });
  });

  /**
   * Applying a manifest replaces the whole object — the most powerful write
   * here — so on the marked cluster it takes the same typed-name gate the
   * confirmations do. Without it the apply's own confirmation, which delivery
   * had already taught the reader to click through, was the way past.
   */
  /**
   * The whole reason the replica comparison exists. It was moved behind
   * `useDeferredValue` here and nothing asserted it still reaches the
   * confirmation: hardwiring `replicasMoved` to `false` left the entire
   * frontend suite green, and with it an Apply that silently loses to the
   * autoscaler seconds later.
   */
  it("warns that an autoscaler will put the replica count back", async () => {
    connections = () => ({
      object: null,
      edges: [
        {
          relation: { verb: "governs" },
          from: {
            kind: "HorizontalPodAutoscaler",
            name: "api",
            namespace: "shop",
            facts: {
              kind: "autoscaler",
              minReplicas: 2,
              maxReplicas: 10,
              conditions: [],
            },
          },
          to: { kind: "Deployment", name: "api", namespace: "shop" },
        },
      ],
    });
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(
      await screen.findAllByText(/will put this number back/)
    ).not.toHaveLength(0);
  });

  /**
   * The read deadline is on every request, writes included, and the layer
   * that fires it only drops our side — it does not undo what the apiserver
   * may already have committed, and a chain of admission webhooks can
   * outlast the wait. Saying "Apply failed" there is a verdict about
   * something nobody looked at, and it invites a second apply.
   */
  it("does not call a timed-out apply a failed one", async () => {
    applyManifest.mockRejectedValue(
      new Error("READ_DEADLINE: the cluster did not answer within 60 s")
    );
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    // The cluster is marked critical in this harness, so the gate comes first.
    await user.type(screen.getByPlaceholderText("test"), "test");
    const confirm = screen
      .getAllByRole("button", { name: /^Apply$/ })
      .at(-1) as HTMLElement;
    await user.click(confirm);

    await waitFor(() => expect(applyManifest).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByText(/We stopped waiting/i)).toBeInTheDocument();
    });
    // Not the wire marker, and not a verdict on something nobody looked at.
    expect(document.body.textContent).not.toContain("READ_DEADLINE:");
  });

  it("holds Apply until the cluster's name is typed", async () => {
    const user = await openWith(PLAIN);

    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(await screen.findByText("Apply Changes?")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("test");

    const confirm = screen
      .getAllByRole("button", { name: /^Apply$/ })
      .at(-1) as HTMLElement;
    expect(confirm).toBeDisabled();

    await user.type(screen.getByPlaceholderText("test"), "test");
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    await waitFor(() => expect(applyManifest).toHaveBeenCalledTimes(1));
  });
});
