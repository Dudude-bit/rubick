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
const dryRunManifest = vi.fn();
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
    dryRunManifest: (...args: unknown[]) => dryRunManifest(...args),
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
  dryRunManifest.mockResolvedValue({
    documents: [
      {
        id: "deployment/shop api",
        outcome: { says: "configured" },
        live: "spec:\n  replicas: 2\n",
        would: "spec:\n  replicas: 4\n",
      },
    ],
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

describe("what the cluster says it would do", () => {
  /**
   * The editor's diff is the buffer against the file it was given. The
   * server's is the object it would store against the one it holds, with
   * defaults and admission in it, and it is the one that answers "what will
   * this actually do".
   */
  it("shows the server's answer once it has one, per document", async () => {
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByTestId("dry-run")).toBeInTheDocument();
    expect(screen.getByText("deployment/shop api")).toBeInTheDocument();
    expect(screen.getByText(/would change/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Apply$/ }).at(-1)
    ).toBeEnabled();
  });

  /** A refusal is the server's answer already; a real apply would be refused the same way. */
  it("does not offer to apply what the server has refused", async () => {
    dryRunManifest.mockResolvedValue({
      documents: [
        {
          id: "deployment/shop api",
          outcome: {
            says: "refused",
            said: 'admission webhook "policy" denied the request: replicas above 3 need an approval label',
          },
          live: "spec:\n  replicas: 2\n",
          would: null,
        },
      ],
    });
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByText(/is refused/)).toBeInTheDocument();
    expect(screen.getByText(/need an approval label/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Apply$/ }).at(-1)
    ).toBeDisabled();
  });

  /**
   * A dry run the cluster did not answer is not a reason to lose the
   * confirmation: the editor's own diff stands in, and says that it is
   * standing in.
   */
  it("falls back to the editor's diff, and says so, when the dry run fails", async () => {
    dryRunManifest.mockRejectedValue(
      new Error("dryRun is not supported by this webhook")
    );
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(
      await screen.findByText(/did not answer the dry run/)
    ).toBeInTheDocument();
    expect(screen.getByTestId("diff")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Apply$/ }).at(-1)
    ).toBeEnabled();
  });
});

describe("a dry run nobody answered", () => {
  /** A proxy's 502 is not the server saying no; blocking on it would block an apply the server never saw. */
  it("says the question went unanswered and leaves the apply enabled", async () => {
    dryRunManifest.mockResolvedValue({
      documents: [
        {
          id: "deployment/shop api",
          outcome: { says: "unanswered", said: "502 Bad Gateway" },
          live: null,
          would: null,
        },
      ],
    });
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(
      await screen.findByText(/got no answer from the cluster/)
    ).toBeInTheDocument();
    expect(screen.getByText(/502 Bad Gateway/)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Apply$/ }).at(-1)
    ).toBeEnabled();
  });
});

describe("what the dry run is asked, and what it draws", () => {
  /**
   * `dryRunManifest` was a `vi.fn()` nothing ever inspected. I pointed the
   * queryFn at the *unedited* buffer and a namespace that does not exist
   * and the whole suite stayed green — a preview of a different question
   * than the one Apply will ask, which is the one thing a preview must not
   * be.
   */
  it("asks about the edited buffer, in the object's own namespace", async () => {
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    await waitFor(() => expect(dryRunManifest).toHaveBeenCalled());
    const [manifest, namespace] = dryRunManifest.mock.calls.at(-1) as [
      string,
      string | null,
    ];
    expect(manifest).toContain("replicas: 4");
    expect(manifest).not.toBe(PLAIN);
    expect(namespace).toBe("shop");
  });

  /**
   * `live` is null for an object that is not there AND for one the read
   * failed on, and the diff took the second for the first: against "" the
   * whole document draws green, "this would all be created", about an
   * object that may exist and be about to be overwritten.
   */
  it("draws no diff when the current object could not be read", async () => {
    dryRunManifest.mockResolvedValue({
      documents: [
        {
          id: "deployment/shop api",
          outcome: {
            says: "liveUnread",
            said: "deployments is forbidden (code: 403)",
          },
          live: null,
          would: "spec:\n  replicas: 4\n",
        },
      ],
    });
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(
      await screen.findByText(/deployments is forbidden/)
    ).toBeInTheDocument();
    expect(screen.queryByTestId("diff")).toBeNull();
  });

  /**
   * The sentence for an unanswered document promises "this is the editor's
   * own diff", and `would` is null there — so the block drew nothing and
   * the promise was empty on the one screen that exists to show a change
   * before it is made.
   */
  it("shows the editor's own diff when the server said nothing", async () => {
    dryRunManifest.mockResolvedValue({
      documents: [
        {
          id: "deployment/shop api",
          outcome: { says: "unanswered", said: "502 Bad Gateway" },
          live: "spec:\n  replicas: 2\n",
          would: null,
        },
      ],
    });
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByText(/502 Bad Gateway/)).toBeInTheDocument();
    expect(screen.getByTestId("diff")).toBeInTheDocument();
  });

  /** And the case it must still draw: an object that really is not there. */
  it("still draws the diff for an object that would be created", async () => {
    dryRunManifest.mockResolvedValue({
      documents: [
        {
          id: "deployment/shop api",
          outcome: { says: "created" },
          live: null,
          would: "spec:\n  replicas: 4\n",
        },
      ],
    });
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    await waitFor(() => expect(screen.getByTestId("diff")).toBeInTheDocument());
  });
});
