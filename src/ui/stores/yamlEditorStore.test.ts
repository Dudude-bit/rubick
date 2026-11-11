import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: { getYamlHistory: vi.fn(async () => []) },
}));

import { followConnections } from "@/lib/refusals";
import { useYamlEditorStore } from "./yamlEditorStore";

beforeEach(() => {
  useYamlEditorStore.setState({ editedContent: "" });
});

describe("formatting the buffer", () => {
  /** The toast said "formatted" whether or not anything was: a buffer that
   *  does not parse is left alone, and says so by answering false. */
  it("leaves a buffer that does not parse as it is, and says it was not formatted", async () => {
    const broken = "kind: [unclosed\n";
    useYamlEditorStore.setState({ editedContent: broken });

    expect(await useYamlEditorStore.getState().formatYaml()).toBe(false);
    expect(useYamlEditorStore.getState().editedContent).toBe(broken);
  });

  /** The other answer: a buffer that parses is rewritten and says so. */
  it("reformats a buffer that parses", async () => {
    useYamlEditorStore.setState({
      editedContent: "kind:   Pod\nmetadata: {name: web}\n",
    });

    expect(await useYamlEditorStore.getState().formatYaml()).toBe(true);
    expect(useYamlEditorStore.getState().editedContent).toBe(
      "kind: Pod\nmetadata:\n  name: web\n"
    );
  });
});

describe("a manifest still being read when the window moves", () => {
  const open = (fetchYaml: () => Promise<string>) =>
    useYamlEditorStore.getState().openEditor({
      title: "api",
      resourceKey: { kind: "Deployment", name: "api", namespace: "shop" },
      fetchYaml,
    });

  /**
   * The read is sent after the history's, to whichever cluster the window is
   * on by then: Ctrl+Tab in between put prod's manifest in an editor opened
   * on staging, and Apply was live again back on staging. Fails if a manifest
   * that arrives on another connection than the editor opened on is shown.
   */
  it("shows nothing, rather than another cluster's manifest", async () => {
    let connection = 1;
    followConnections(() => connection);

    await open(async () => {
      connection = 2;
      return "kind: Deployment\n";
    });

    expect(useYamlEditorStore.getState()).toMatchObject({
      open: false,
      editedContent: "",
    });
    followConnections(() => 0);
  });

  /** Fails if the guard above closes an editor whose window stayed put. */
  it("shows the manifest when the window stayed", async () => {
    await open(async () => "kind: Deployment\n");

    expect(useYamlEditorStore.getState()).toMatchObject({
      open: true,
      editedContent: "kind: Deployment\n",
    });
    useYamlEditorStore.getState().closeEditor();
  });
});

describe("a manifest read that answers after its editor is gone", () => {
  const other = { kind: "Deployment", name: "cart", namespace: "shop" };
  const openOn = (name: string, fetchYaml: () => Promise<string>) =>
    useYamlEditorStore.getState().openEditor({
      title: name,
      resourceKey: { kind: "Deployment", name, namespace: "shop" },
      fetchYaml,
    });
  /** A read the test answers when it chooses. */
  const slow = () => {
    let answer!: (yaml: string) => void;
    let fail!: (error: Error) => void;
    const read = new Promise<string>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    });
    return { read, answer, fail };
  };
  const editing = async () => {
    await openOn("cart", async () => "kind: Deployment\n");
    useYamlEditorStore.getState().setEditedContent("replicas: 3\n");
  };
  const stillEditing = () =>
    expect(useYamlEditorStore.getState()).toMatchObject({
      open: true,
      resourceKey: other,
      originalContent: "kind: Deployment\n",
      editedContent: "replicas: 3\n",
    });

  beforeEach(() => useYamlEditorStore.getState().closeEditor());

  /**
   * The guard against another cluster's manifest closed the store, and the
   * store is whatever editor is open by then: a slow read from the cluster
   * left behind closed the editor being typed into on the next one. Fails if
   * a read on a stale connection touches an editor it did not open.
   */
  it("leaves the editor opened since on another cluster open, edits included", async () => {
    let connection = 1;
    followConnections(() => connection);
    const { read, answer } = slow();
    const first = openOn("api", () => read);

    useYamlEditorStore.getState().closeEditor();
    connection = 2;
    await editing();
    answer("kind: Deployment\nmetadata: {name: api}\n");
    await first;

    stillEditing();
    followConnections(() => 0);
  });

  /** The same read on one cluster: fails if the first object's manifest
   *  replaces the buffer of the editor opened after it. */
  it("does not put its manifest into the editor opened after it", async () => {
    const { read, answer } = slow();
    const first = openOn("api", () => read);

    await editing();
    answer("kind: Deployment\nmetadata: {name: api}\n");
    await first;

    stillEditing();
  });

  /** Fails if a read that failed late closes the editor opened after it, or
   *  raises its toast over it. */
  it("keeps its failure to itself", async () => {
    const { read, fail } = slow();
    const first = openOn("api", () => read);

    await editing();
    fail(new Error("timed out"));

    await expect(first).resolves.toBeUndefined();
    stillEditing();
  });

  /** Fails if a read that fails after Close raises "could not read the
   *  manifest" over a screen that no longer asks for it. */
  it("says nothing of a failure once its own editor was closed", async () => {
    const { read, fail } = slow();
    const first = openOn("api", () => read);

    useYamlEditorStore.getState().closeEditor();
    fail(new Error("timed out"));

    await expect(first).resolves.toBeUndefined();
    expect(useYamlEditorStore.getState().open).toBe(false);
  });
});
