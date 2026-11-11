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
