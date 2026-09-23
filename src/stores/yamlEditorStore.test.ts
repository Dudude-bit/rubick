import { beforeEach, describe, expect, it } from "vitest";

import { useYamlEditorStore } from "./yamlEditorStore";

beforeEach(() => {
  useYamlEditorStore.setState({ editedContent: "" });
});

describe("formatting the buffer", () => {
  /** The toast said "formatted" whether or not anything was: a buffer that
   *  does not parse is left alone, and says so by answering false. */
  it("leaves a buffer that does not parse as it is, and says it did", async () => {
    const broken = "kind: [unclosed\n";
    useYamlEditorStore.setState({ editedContent: broken });

    expect(await useYamlEditorStore.getState().formatYaml()).toBe(false);
    expect(useYamlEditorStore.getState().editedContent).toBe(broken);
  });

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
