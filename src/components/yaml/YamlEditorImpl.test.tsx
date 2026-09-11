import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * `react-codemirror` mounts the editor inside a wrapper `div` of its own, and
 * the `height` prop only styles the `.cm-editor` beneath it. A percentage
 * there resolves against that wrapper — so with the wrapper left at `auto`
 * the editor grew to the whole document instead of to its box, the container
 * clipped it, and a long manifest had no scrollbar and did not answer the
 * mouse wheel (issue #163, reported on 4.11.0).
 *
 * Two of the three surfaces hit it: the detail page's YAML tab and the peek
 * panel's, both of which pass no `className`. The edit dialog happened to
 * pass `className="h-full"` and so escaped — which is why this belongs in the
 * component and not at each call site.
 */

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
