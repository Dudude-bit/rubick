import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd } from "@/components/ui/kbd";
import { setHostOs } from "@/lib/platform";

describe("Kbd", () => {
  it("shows the platform form and keeps the logical one accessible", () => {
    setHostOs("windows");
    render(<Kbd shortcut="mod+K" />);
    const el = screen.getByText("Ctrl+K");
    expect(el.tagName).toBe("KBD");
    expect(el).toHaveAttribute("aria-label", "Control K");
  });

  it("uses the command glyph on macOS", () => {
    setHostOs("macos");
    render(<Kbd shortcut="mod+K" />);
    expect(screen.getByText("⌘K")).toBeInTheDocument();
  });
});
