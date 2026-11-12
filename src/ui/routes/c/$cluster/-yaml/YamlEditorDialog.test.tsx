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

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithRouter } from "@/test/render";
import { useYamlEditorStore } from "@/stores/yamlEditorStore";
import { useClusterIdentityStore } from "@/stores/clusterIdentityStore";
import { marcoReview } from "@/test/marco";
import { WITHHELD_MARKER } from "@/lib/withheld";

const detectInClusterExtensions = vi.fn();
const listCustomResources = vi.fn();
const applyManifest = vi.fn();
const dryRunManifest = vi.fn();
const checkAccess = vi.fn();
const toast = vi.fn();
const validateManifest = vi.fn();
const addYamlHistoryEntry = vi.fn(async (..._: unknown[]) => {});
/** The neighbourhood the dialog asks about, per test. */
let connections: () => {
  object: null;
  edges: unknown[];
  notLookedAt: unknown[];
} = () => ({
  object: null,
  edges: [],
  notLookedAt: [],
});

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: () => detectInClusterExtensions(),
    listCustomResources: (...args: unknown[]) => listCustomResources(...args),
    applyManifest: (...args: unknown[]) => applyManifest(...args),
    dryRunManifest: (...args: unknown[]) => dryRunManifest(...args),
    checkAccess: (...args: unknown[]) => checkAccess(...args),
    getResourceConnections: async () => connections(),
    getYamlHistory: async () => [],
    addYamlHistoryEntry: (...args: unknown[]) => addYamlHistoryEntry(...args),
    validateManifest: (...args: unknown[]) => validateManifest(...args),
  },
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => toast(...args),
  useToast: () => ({ toast }),
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
  await renderWithRouter(<YamlEditorDialog />, {
    at: "/c/test",
    route: "/c/$cluster",
  });
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
  connections = () => ({ object: null, edges: [], notLookedAt: [] });
  useYamlEditorStore.getState().closeEditor();
  applyManifest.mockResolvedValue({
    documents: [{ id: "deployment/shop api", outcome: { says: "applied" } }],
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
      notLookedAt: [],
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

describe("what an apply says when it ends", () => {
  // A refusal one test teaches the app is kept for the connection: the next
  // test gets a connection of its own.
  afterEach(() => {
    checkAccess.mockReset();
    useClusterStore.setState((s) => ({
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
  });

  const told = (title: string, variant: "default" | "destructive") =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title, variant })
    );

  async function applyAnswering(answer: () => Promise<unknown>) {
    applyManifest.mockImplementation(answer);
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    await user.click(
      screen.getAllByRole("button", { name: /^Apply$/ }).at(-1) as HTMLElement
    );
    await waitFor(() => expect(applyManifest).toHaveBeenCalledTimes(1));
    return screen.findByTestId("yaml-result");
  }

  /**
   * The read deadline is on every request, writes included, and the layer
   * that fires it only drops our side: a chain of admission webhooks can
   * outlast the wait and the server store it all the same. The backend
   * answered every such patch "failed", and the result block drew it red.
   * Fails if an apply nobody answered is called failed, or drawn as one.
   */
  it("does not call an apply nobody answered a failed one", async () => {
    const result = await applyAnswering(async () => ({
      documents: [
        {
          id: "deployment/shop api",
          outcome: {
            says: "unanswered",
            said: "the cluster did not answer within 60 s",
          },
        },
      ],
    }));

    expect(result).toHaveAttribute("data-verdict", "unanswered");
    expect(result).toHaveTextContent("The cluster did not answer");
    expect(result).toHaveTextContent(
      "deployment/shop api got no answer (the cluster did not answer within 60 s). It may have been applied"
    );
    told("The cluster did not answer", "default");
    expect(toast).toHaveBeenCalledTimes(1);
  });

  /**
   * The apply stops at the first document that does not go in, and used to
   * answer with that one alone: nothing said the two before it were stored.
   * Fails if a stored document is not named as stored, or an unsent one is
   * left out.
   */
  it("says which documents went in before the one that was refused", async () => {
    const result = await applyAnswering(async () => ({
      documents: [
        { id: "configmap/shop a", outcome: { says: "applied" } },
        {
          id: "configmap/shop b",
          outcome: {
            says: "refused",
            code: "KUBE_API_ERROR",
            said: "exceeded quota",
          },
        },
        { id: "configmap/shop c", outcome: { says: "notSent" } },
      ],
    }));

    expect(result).toHaveAttribute("data-verdict", "failed");
    expect(result).toHaveTextContent("configmap/shop a applied");
    expect(result).toHaveTextContent(
      "configmap/shop b refused: exceeded quota"
    );
    expect(result).toHaveTextContent("configmap/shop c not sent");
    told("Apply failed", "destructive");
    expect(toast.mock.calls[0][0].description).toContain(
      "configmap/shop a applied"
    );
  });

  /**
   * A 403 on the patch never reached the code that remembers refusals: the
   * backend folded it into a "failed" result, and the refusal was only ever
   * looked for on a rejected command. Fails if Apply stays offered once the
   * authorizer confirms the refusal.
   */
  it("remembers a patch the cluster refused this user", async () => {
    checkAccess.mockImplementation(async (questions: unknown[]) =>
      questions.map(() => ({
        allowed: applyManifest.mock.calls.length === 0,
        reason: null,
      }))
    );
    await applyAnswering(async () => ({
      documents: [
        {
          id: "deployment/shop api",
          outcome: {
            says: "refused",
            code: "PERMISSION_DENIED",
            said: "deployments.apps is forbidden",
          },
        },
      ],
    }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Apply$/ })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    );
  });

  /** A command that fails whole sent nothing, or lost its session: that one is a failure. */
  it("calls a command that failed whole a failed apply", async () => {
    const result = await applyAnswering(async () => {
      throw new Error("Not connected to test");
    });

    expect(result).toHaveAttribute("data-verdict", "failed");
    expect(result).toHaveTextContent("Not connected to test");
    told("Apply failed", "destructive");
  });

  /** And the ordinary case keeps its word: every document in, said as a success. */
  it("calls an apply every document went into a success", async () => {
    const result = await applyAnswering(async () => ({
      documents: [{ id: "deployment/shop api", outcome: { says: "applied" } }],
    }));

    expect(result).toHaveAttribute("data-verdict", "ok");
    expect(result).toHaveTextContent("deployment/shop api applied");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Apply succeeded" })
    );
  });
});

describe("an answer that comes back after its editor is gone", () => {
  const APPLIED = {
    documents: [{ id: "deployment/shop api", outcome: { says: "applied" } }],
  };
  const EDITED = PLAIN.replace("replicas: 2", "replicas: 4");
  const settings = {
    title: "Edit ConfigMap: settings",
    resourceKey: { kind: "ConfigMap", name: "settings", namespace: "shop" },
    fetchYaml: async () => "kind: ConfigMap\n",
  };

  /** Sends `command` from the editor on the Deployment and holds its answer. */
  async function pending(command: typeof applyManifest, confirm: boolean) {
    let answer: (value: unknown) => void = () => {};
    command.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const user = await openWith(PLAIN);
    await user.click(
      screen.getByRole("button", { name: confirm ? /^Apply$/ : /Validate/ })
    );
    if (confirm)
      await user.click(
        screen.getAllByRole("button", { name: /^Apply$/ }).at(-1) as HTMLElement
      );
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    return { user, answer: (value: unknown) => act(async () => answer(value)) };
  }

  /**
   * Close is live while an apply is out, and the history key was read from
   * the store when the answer came: with no editor open it was empty and the
   * applied revision was never recorded. Fails if it is not filed under the
   * object it was applied to.
   */
  it("files the applied manifest under its own object when the editor has closed", async () => {
    const { answer } = await pending(applyManifest, true);
    act(() => useYamlEditorStore.getState().closeEditor());
    await answer(APPLIED);

    expect(addYamlHistoryEntry).toHaveBeenCalledWith(
      "test:Deployment:shop:api",
      expect.objectContaining({ content: EDITED, label: "Applied" })
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Apply succeeded" })
    );
  });

  /**
   * With another object's editor opened meanwhile, the answer landed there:
   * "Success" under a manifest nobody applied, the first object's manifest
   * in the second one's history, and the second editor's own apply released
   * while still out. Fails if any of the three reaches the editor on screen.
   */
  it("leaves an editor opened on another object since untouched", async () => {
    const { user, answer } = await pending(applyManifest, true);
    act(() => useYamlEditorStore.getState().closeEditor());
    await act(() => useYamlEditorStore.getState().openEditor(settings));
    act(() =>
      useYamlEditorStore.getState().setEditedContent("kind: ConfigMap\n#\n")
    );
    applyManifest.mockReturnValueOnce(new Promise(() => {}));
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    await user.click(
      screen.getAllByRole("button", { name: /^Apply$/ }).at(-1) as HTMLElement
    );
    await waitFor(() => expect(applyManifest).toHaveBeenCalledTimes(2));

    await answer(APPLIED);

    const store = useYamlEditorStore.getState();
    expect(screen.queryByTestId("yaml-result")).toBeNull();
    expect(store.isApplying).toBe(true);
    expect(store.history["test:ConfigMap:shop:settings"] ?? []).toEqual([]);
    expect(store.history["test:Deployment:shop:api"]).toEqual([
      expect.objectContaining({ content: EDITED }),
    ]);
  });

  /** The same for Validate: "valid" about one manifest must not appear under another. */
  it("does not answer a validation in an editor opened on another object since", async () => {
    const { answer } = await pending(validateManifest, false);
    act(() => useYamlEditorStore.getState().closeEditor());
    await act(() => useYamlEditorStore.getState().openEditor(settings));
    act(() => useYamlEditorStore.getState().setIsValidating(true));

    await answer({ success: true, stdout: "ok", stderr: "", exit_code: 0 });

    expect(screen.queryByTestId("yaml-result")).toBeNull();
    expect(useYamlEditorStore.getState().isValidating).toBe(true);
    expect(toast).not.toHaveBeenCalled();
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

describe("a confirmation opened again over the same buffer", () => {
  /**
   * The answer was kept under the buffer's text for as long as the editor
   * stayed open, so Apply, Cancel, an image rolled by CI, Apply again drew
   * the first answer under "what it holds now" and the forced apply put the
   * old image back unseen. Fails if the second opening does not ask again,
   * or draws anything of the first answer.
   */
  it("asks the server again and shows nothing of the earlier answer", async () => {
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(await screen.findByText(/would change/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(dryRunManifest).toHaveBeenCalledTimes(1);

    let answer: (run: unknown) => void = () => {};
    dryRunManifest.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByText(/Asking the cluster/)).toBeInTheDocument();
    expect(screen.queryByTestId("dry-run")).toBeNull();
    expect(dryRunManifest).toHaveBeenCalledTimes(2);

    await act(async () =>
      answer({
        documents: [
          {
            id: "deployment/shop api",
            outcome: { says: "created" },
            live: null,
            would: "spec:\n  replicas: 4\n",
          },
        ],
      })
    );
    expect(await screen.findByText(/would be created/)).toBeInTheDocument();
    expect(screen.queryByText(/would change/)).toBeNull();
  });
});

describe("a replica count that moved on the cluster under the editor", () => {
  const at = (replicas: number) =>
    PLAIN.replace("replicas: 2", `replicas: ${replicas}`);
  const LABELLED_BY_HAND = PLAIN.replace(
    "  namespace: shop",
    "  namespace: shop\n  labels:\n    tier: web"
  );
  const answered = (live: number) => ({
    documents: [
      {
        id: "deployment/shop api",
        outcome: { says: "configured" },
        live: at(live),
        would: at(2),
      },
    ],
  });

  /** Opens on the Deployment at 2 replicas; the edit, if any, leaves the count alone. */
  async function openAt2(edited?: string) {
    await renderWithRouter(<YamlEditorDialog />, {
      at: "/c/test",
      route: "/c/$cluster",
    });
    await useYamlEditorStore.getState().openEditor({
      title: "Edit Deployment: api",
      resourceKey: { kind: "Deployment", name: "api", namespace: "shop" },
      fetchYaml: async () => PLAIN,
    });
    if (edited) useYamlEditorStore.getState().setEditedContent(edited);
    return userEvent.setup();
  }

  beforeEach(() => {
    connections = () => ({
      object: null,
      notLookedAt: [],
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
  });

  /**
   * The editor read the Deployment at 2; the autoscaler went to 12; the
   * reader changed a label. Both buffers say 2, so nothing named the
   * autoscaler and the forced apply cut ten pods with a plain "Apply". Fails
   * if the confirmation does not say the count moved and who owns it.
   */
  it("says the count moved and names the autoscaler that owns it", async () => {
    dryRunManifest.mockResolvedValue(answered(12));
    const user = await openAt2(LABELLED_BY_HAND);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByTestId("replicas-moved")).toHaveTextContent(
      "has moved to 12 since this manifest was read. Applying sets it to 2."
    );
    expect(
      await screen.findAllByText(/will put this number back/)
    ).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: /Apply anyway/ })
    ).toBeInTheDocument();
  });

  /** The cost of the one above: a save that leaves the count where the cluster has it names no autoscaler. */
  it("stays quiet when the cluster holds the count being applied", async () => {
    dryRunManifest.mockResolvedValue(answered(2));
    const user = await openAt2(LABELLED_BY_HAND);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByTestId("dry-run")).toBeInTheDocument();
    expect(screen.queryByTestId("replicas-moved")).toBeNull();
    expect(screen.queryByText(/will put this number back/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Apply anyway/ })).toBeNull();
  });

  /**
   * With the current object unread, or the dry run unanswered, nobody knows
   * whether the count moved. Fails if that is drawn as a save the autoscaler
   * has no part in.
   */
  it.each([
    [
      "the current object could not be read",
      () =>
        dryRunManifest.mockResolvedValue({
          documents: [
            {
              id: "deployment/shop api",
              outcome: { says: "liveUnread", said: "deployments is forbidden" },
              live: null,
              would: at(2),
            },
          ],
        }),
    ],
    [
      "the dry run was not answered",
      () => dryRunManifest.mockRejectedValue(new Error("connection reset")),
    ],
  ])(
    "names the autoscaler and what went unchecked when %s",
    async (_, given) => {
      given();
      const user = await openAt2(LABELLED_BY_HAND);
      await user.click(screen.getByRole("button", { name: /^Apply$/ }));

      expect(
        await screen.findByText(
          /Whether this apply changes the replica count could not be checked/
        )
      ).toBeInTheDocument();
      expect(screen.getAllByText(/will put this number back/)).not.toHaveLength(
        0
      );
      expect(screen.queryByTestId("replicas-moved")).toBeNull();
    }
  );

  /**
   * Apply is offered on an untouched buffer, and that buffer is as old as
   * the read: with no dry run the confirmation drew nothing and the apply
   * reset the count all the same. Fails if the server is not asked.
   */
  it("asks the server what an untouched buffer would do", async () => {
    dryRunManifest.mockResolvedValue(answered(12));
    const user = await openAt2();
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByTestId("replicas-moved")).toBeInTheDocument();
    expect(dryRunManifest).toHaveBeenCalledWith(PLAIN, "shop");
  });

  /** With nothing edited there is no editor's diff to fall back on, and the sentence must not promise one. */
  it("does not promise the editor's diff where the buffer was not edited", async () => {
    dryRunManifest.mockRejectedValue(new Error("connection reset"));
    const user = await openAt2();
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));

    expect(await screen.findByTestId("dry-run-standing")).toHaveTextContent(
      "(connection reset), so what applying would change is unknown."
    );
    expect(screen.queryByTestId("diff")).toBeNull();
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

describe("a manifest that holds a withheld private key", () => {
  const CONFIG = (withKey: boolean) =>
    [
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: nginx",
      "  namespace: shop",
      "data:",
      "  nginx.conf: worker_processes 2;",
      ...(withKey ? [`  server.key: '${WITHHELD_MARKER}'`] : []),
      "",
    ].join("\n");

  /**
   * A ConfigMap's private key reaches the editor as a placeholder, and Apply
   * stored that placeholder as the key: no edit needed, nothing about it in
   * the confirmation. Fails if Apply is offered, or the cluster is asked
   * anything, while the placeholder is still in the buffer.
   */
  it("names the withheld key and offers no apply until it is out of the buffer", async () => {
    await renderWithRouter(<YamlEditorDialog />, {
      at: "/c/test",
      route: "/c/$cluster",
    });
    await useYamlEditorStore.getState().openEditor({
      title: "Edit ConfigMap: nginx",
      resourceKey: { kind: "ConfigMap", name: "nginx", namespace: "shop" },
      fetchYaml: async () => CONFIG(true),
    });
    const user = userEvent.setup();

    expect(await screen.findByRole("status")).toHaveTextContent(
      /^Withheld: server\.key\..*would write the placeholder as the value/
    );
    const apply = () => screen.getByRole("button", { name: /^Apply$/ });
    expect(apply()).toHaveAttribute("aria-disabled", "true");
    await user.click(apply());
    expect(screen.queryByText("Apply Changes?")).toBeNull();
    expect(dryRunManifest).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();

    act(() => useYamlEditorStore.getState().setEditedContent(CONFIG(false)));
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(apply());
    expect(await screen.findByText("Apply Changes?")).toBeInTheDocument();
  });
});

describe("applying where the cluster says this user may not", () => {
  /**
   * Marco opened Edit YAML on checkout-config and the editor offered a live
   * Apply that his Role refuses. Fails if Apply opens its confirmation or
   * reaches the cluster while can-i patch configmaps says no.
   */
  it("greys Apply with the can-i question and applies nothing", async () => {
    checkAccess.mockImplementation(marcoReview);
    useClusterStore.setState((s) => ({
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    await renderWithRouter(<YamlEditorDialog />, {
      at: "/c/test",
      route: "/c/$cluster",
    });
    await useYamlEditorStore.getState().openEditor({
      title: "Edit ConfigMap: checkout-config",
      resourceKey: {
        kind: "ConfigMap",
        name: "checkout-config",
        namespace: "team-checkout",
      },
      fetchYaml: async () => "data:\n  LOG_LEVEL: info\n",
    });
    useYamlEditorStore
      .getState()
      .setEditedContent("data:\n  LOG_LEVEL: debug\n");
    const user = userEvent.setup();

    const apply = () => screen.getByRole("button", { name: /^Apply$/ });
    await waitFor(() =>
      expect(apply()).toHaveAttribute("aria-disabled", "true")
    );
    await user.hover(apply());
    expect(
      (
        await screen.findAllByText(
          /can-i patch configmaps\/checkout-config -n team-checkout/
        )
      ).length
    ).toBeGreaterThan(0);
    await user.click(apply());
    expect(screen.queryByText("Apply Changes?")).toBeNull();
    expect(applyManifest).not.toHaveBeenCalled();
  });
});

describe("a manifest read from a cluster the window has left", () => {
  /**
   * The editor sits over the whole shell, so Ctrl+Tab moved the window to
   * prod under a staging manifest and Apply sent it to prod. Fails if Apply
   * or Validate stay live once the window is on another cluster.
   */
  it("applies nothing and says where the manifest came from", async () => {
    checkAccess.mockReset();
    useClusterStore.setState((s) => ({
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    const user = await openWith(PLAIN);
    await user.click(screen.getByRole("button", { name: /^Apply$/ }));
    expect(await screen.findByText("Apply Changes?")).toBeInTheDocument();

    act(() => useClusterStore.setState({ currentContext: "prod" }));

    expect(screen.queryByText("Apply Changes?")).toBeNull();
    const apply = screen.getByRole("button", { name: /^Apply$/ });
    expect(apply).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /Validate/ })).toBeDisabled();
    await user.hover(apply);
    expect(
      (await screen.findAllByText(/Read from test, and the window is on/))
        .length
    ).toBeGreaterThan(0);
    await user.click(apply);
    expect(screen.queryByText("Apply Changes?")).toBeNull();
    expect(applyManifest).not.toHaveBeenCalled();
  });
});
