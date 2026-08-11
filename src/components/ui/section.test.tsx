import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";

describe("Section", () => {
  it("renders a heading, a count and a description", () => {
    render(
      <Section>
        <SectionHeader title="Nodes" count={2} description="two ready" />
      </Section>
    );
    expect(screen.getByRole("heading", { name: "Nodes" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("two ready")).toBeInTheDocument();
  });

  it("carries no surface of its own", () => {
    const { container } = render(
      <Section>
        <SectionHeader title="Pods" />
      </Section>
    );
    const cls = container.firstElementChild!.className;
    // A card would bring a background, a border and a shadow. The whole
    // point of the redesign is that a section brings none of them.
    expect(cls).not.toMatch(/\bbg-(card|canvas|popover)\b/);
    expect(cls).not.toMatch(/\bborder\b(?!-)/);
    expect(cls).not.toMatch(/shadow/);
  });

  it("separates a list body with a hairline, not a box", () => {
    const { container } = render(<SectionBody>rows</SectionBody>);
    expect(container.firstElementChild!.className).toContain("border-hair");
  });

  it("places actions after the title", () => {
    render(
      <Section>
        <SectionHeader title="Pods" actions={<button>Filter</button>} />
      </Section>
    );
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
  });
});
