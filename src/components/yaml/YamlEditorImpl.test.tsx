import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const captured: { props?: Record<string, unknown> } = {};
vi.mock("@uiw/react-codemirror", () => ({
  default: (props: Record<string, unknown>) => {
    captured.props = props;
    return <div data-testid="codemirror" />;
  },
}));
vi.mock("@/stores/themeStore", () => ({
  useThemeStore: (pick: (s: { theme: string }) => unknown) =>
    pick({ theme: "dark" }),
}));

const { YamlEditor } = await import("./YamlEditorImpl");

describe("YamlEditor", () => {
  /**
   * `react-codemirror` mounts the editor inside a wrapper `div` of its own,
   * and `height` only styles the `.cm-editor` beneath it. A percentage there
   * resolves against that wrapper — left at `auto`, the editor grew to the
   * whole document, the container clipped it, and a long manifest had no
   * scrollbar and ignored the wheel (issue #163). Two of the three surfaces
   * hit it; the edit dialog escaped only because it passes `h-full`, which
   * is why this belongs in the component.
   */
  it("gives its own wrapper the height it was handed, not just the editor", () => {
    render(<YamlEditor value="a: 1" readOnly height="100%" />);
    // `style` is not a prop react-codemirror reads; it lands on the wrapper
    // div it renders, which is the box `.cm-editor { height: 100% }` needs.
    expect(captured.props?.style).toEqual({ height: "100%" });
    expect(captured.props?.height).toBe("100%");
  });

  it("carries a fixed height through the same way", () => {
    render(<YamlEditor value="a: 1" readOnly height="200px" />);
    expect(captured.props?.style).toEqual({ height: "200px" });
  });

  /** The default is the one every read-only surface relies on. */
  it("defaults to filling its container", () => {
    render(<YamlEditor value="a: 1" readOnly />);
    expect(captured.props?.style).toEqual({ height: "100%" });
  });
});
