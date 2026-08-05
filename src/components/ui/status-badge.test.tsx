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

// The chip was the last container on the canvas, and it spent colour on the
// healthy majority: twenty Running rows shouted as loudly as the one that
// crashed. These hold the column to the rule the rest of the design follows.
describe("no chip, colour only on anomalies", () => {
  const classOf = (status: string) =>
    render(<StatusBadge status={status} />).container.firstElementChild!
      .className;

  it.each(["Running", "Succeeded", "Bound", "Ready"])(
    "leaves %s uncoloured",
    (status) => {
      const cls = classOf(status);
      expect(cls).not.toMatch(/text-(ok|warn|err|info)\b/);
      expect(cls).toContain("text-fg-mid");
    }
  );

  it.each([
    ["CrashLoopBackOff", "text-err"],
    ["Failed", "text-err"],
    ["Pending", "text-info"],
    ["NotReady", "text-warn"],
  ])("colours %s as %s", (status, expected) => {
    expect(classOf(status)).toContain(expected);
  });

  it.each(["Running", "CrashLoopBackOff"])(
    "wraps %s in no container at all",
    (status) => {
      const cls = classOf(status);
      expect(cls).not.toMatch(/\brounded/);
      expect(cls).not.toMatch(/\bbg-/);
      expect(cls).not.toMatch(/\bpx-/);
      expect(cls).not.toMatch(/\bpy-[1-9]/);
    }
  );

  it("still says the status in words, so colour is never alone", () => {
    const { getByText } = render(<StatusBadge status="CrashLoopBackOff" />);
    expect(getByText("CrashLoopBackOff")).toBeInTheDocument();
  });
});
