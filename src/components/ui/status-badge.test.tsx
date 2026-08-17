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

  /**
   * The constraint the whole translation project rests on. `statusRole`
   * derives the colour by looking the status up in a table of English keys
   * and falls back to `neutral` on a miss, so a translated `status` would
   * turn every badge in the app grey at once — with no error and no failing
   * test, because the rest of them pass English.
   *
   * The code decides the colour, the child decides what is read. A lint
   * guard refuses `status={t(...)}` so this cannot be undone by hand.
   */
  it("takes its colour from the code, not from the label shown", () => {
    const { container } = render(
      <StatusBadge status="CrashLoopBackOff">
        перезапускается по кругу
      </StatusBadge>
    );
    expect(screen.getByText("перезапускается по кругу")).toBeInTheDocument();
    expect(container.firstElementChild!.className).toContain("text-err");
  });

  /** And a status nobody has a colour for stays readable rather than blank. */
  it("shows an unknown status as itself, in the neutral role", () => {
    const { container } = render(<StatusBadge status="SomeCustomPhase" />);
    expect(screen.getByText("SomeCustomPhase")).toBeInTheDocument();
    expect(container.firstElementChild!.className).toContain("text-fg-mut");
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

  it.each([
    ["Running", "text-ok"],
    ["Succeeded", "text-ok"],
    ["Completed", "text-fg-mut"],
  ])("gives %s the %s role colour", (status, expected) => {
    expect(classOf(status)).toContain(expected);
  });

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

// Colour is the fastest channel, not the only one. Roughly one reader in
// twelve cannot separate the red from the green, and a screenshot in
// greyscale is how half of these end up in a bug report.
describe("severity survives without colour", () => {
  const iconOf = (status: string) => {
    const { container } = render(<StatusBadge status={status} />);
    const icon = container.querySelector('[data-testid="status-badge-icon"]');
    return icon?.getAttribute("class")?.match(/lucide-[a-z-]+/)?.[0] ?? null;
  };

  it("gives each role a distinct glyph", () => {
    const shapes = [
      "Running",
      "Pending",
      "NotReady",
      "CrashLoopBackOff",
      "Completed",
    ].map(iconOf);
    expect(shapes.every(Boolean)).toBe(true);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("hides the glyph from a screen reader, which already hears the word", () => {
    const { container } = render(<StatusBadge status="Failed" />);
    expect(
      container.querySelector('[data-testid="status-badge-icon"]')
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("drops the glyph where the layout already carries a mark", () => {
    const { container } = render(
      <StatusBadge status="Failed" showIcon={false} />
    );
    expect(
      container.querySelector('[data-testid="status-badge-icon"]')
    ).toBeNull();
  });

  it("prefers an explicit dot over the glyph", () => {
    const { container } = render(<StatusBadge status="Failed" showDot />);
    expect(
      container.querySelector('[data-testid="status-badge-icon"]')
    ).toBeNull();
  });
});
