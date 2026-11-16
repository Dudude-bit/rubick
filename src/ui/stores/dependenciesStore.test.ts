import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const answers: Array<(value: unknown) => void> = [];
const pending = () =>
  new Promise((resolve) => {
    answers.push(resolve);
  });
const checkKubectlAvailability = vi.fn(pending);
const checkHelmAvailability = vi.fn(pending);
vi.mock("@/lib/commands", () => ({
  commands: {
    checkKubectlAvailability: () => checkKubectlAvailability(),
    checkHelmAvailability: () => checkHelmAvailability(),
  },
}));

const { useDependenciesStore } = await import("./dependenciesStore");

const found = (path: string) => ({
  available: true,
  version: "v1.31.0",
  error: null,
  path,
  searchedPaths: [],
});

const answerAll = async (path = "/usr/local/bin/kubectl") => {
  for (const resolve of answers.splice(0)) resolve(found(path));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  await answerAll();
  checkKubectlAvailability.mockClear();
  checkHelmAvailability.mockClear();
  useDependenciesStore.setState({
    helm: null,
    kubectl: null,
    unread: { helm: null, kubectl: null },
    isChecking: false,
  });
});

describe("the tool availability check", () => {
  /** Breaks when helm answering first lets a screen ask about kubectl again while the first question is still running, which ran kubectl twelve times across Settings tabs. */
  it("asks about kubectl once however many screens want the answer before it arrives", async () => {
    const store = useDependenciesStore.getState();
    void store.ensureDependencies();
    void store.ensureDependencies();
    void store.checkKubectlAvailability();
    answers[0](found("/usr/local/bin/helm"));
    await new Promise((r) => setTimeout(r, 0));
    void useDependenciesStore.getState().ensureDependencies();
    expect(checkKubectlAvailability).toHaveBeenCalledTimes(1);
    await answerAll();
    expect(useDependenciesStore.getState().kubectl?.available).toBe(true);
    expect(useDependenciesStore.getState().isChecking).toBe(false);
  });

  /** Breaks when the answer is not kept for the session and every Settings tab asks again. */
  it("does not ask again once it has an answer", async () => {
    void useDependenciesStore.getState().ensureDependencies();
    await answerAll();
    await useDependenciesStore.getState().ensureDependencies();
    expect(checkKubectlAvailability).toHaveBeenCalledTimes(1);
  });

  /** Breaks when a path change joins a question already asked about the old path and shows its stale answer. */
  it("asks once more after a path change that lands while a question is running", async () => {
    void useDependenciesStore.getState().checkKubectlAvailability();
    const after = useDependenciesStore.getState().recheckAfterPathChange();
    void useDependenciesStore.getState().recheckAfterPathChange();
    await answerAll("/old/kubectl");
    await answerAll("/new/kubectl");
    await after;
    expect(checkKubectlAvailability).toHaveBeenCalledTimes(2);
    expect(useDependenciesStore.getState().kubectl?.path).toBe("/new/kubectl");
  });
});

describe("a check that could not be answered", () => {
  /**
   * A rejected check was stored as `available: false`, so a failed read said
   * "not found" and sent the reader to install a binary they had. Fails if
   * the failure is stored as an answer instead of as a third state.
   */
  it("is kept as unread, never as not found", async () => {
    checkKubectlAvailability.mockRejectedValueOnce(new Error("spawn failed"));
    await useDependenciesStore.getState().checkKubectlAvailability();
    const state = useDependenciesStore.getState();
    expect(state.kubectl).toBeNull();
    expect(state.unread.kubectl).toMatch(/spawn failed/);
    expect(state.isChecking).toBe(false);
  });

  it("clears the unread state when the next check answers", async () => {
    useDependenciesStore.setState({
      unread: { helm: null, kubectl: "spawn failed" },
    });
    const asked = useDependenciesStore.getState().checkKubectlAvailability();
    await answerAll();
    await asked;
    expect(useDependenciesStore.getState().unread.kubectl).toBeNull();
    expect(useDependenciesStore.getState().kubectl?.available).toBe(true);
  });
});
