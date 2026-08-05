import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConditionBadge, StatusBadge } from "@/components/ui/status-badge";

describe("StatusBadge", () => {
  it("renders the status text", () => {
    render(<StatusBadge status="Running" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("uses role utilities and no colour literals", () => {
    const { container } = render(<StatusBadge status="CrashLoopBackOff" />);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain("text-err");
    expect(cls).not.toMatch(/(red|green|blue|yellow|gray|zinc)-\d{3}/);
  });

  it("does not rely on colour alone when a dot is requested", () => {
    render(<StatusBadge status="Failed" showDot />);
    // the text remains the carrier of meaning; the dot is reinforcement
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("maps conditions to roles", () => {
    const { container } = render(
      <ConditionBadge conditionStatus="False" conditionType="Ready" />
    );
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(container.firstElementChild!.className).toContain("text-err");
  });
});
