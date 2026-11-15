import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { CELL_PADS_PX } from "@/components/ui/column-shares";
import { formatWhen } from "@/lib/utils";
import { statusCellPx } from "../-list/columns";
import { WithProblem } from "./ProblemTone";
import {
  PROBLEM_MARK_PX,
  PROBLEM_MARK_ROOM_PX,
  PROBLEM_STALE_PX,
  PROBLEM_STALE_ROOM_PX,
  type Problem,
} from "./problem";

const AT = Date.parse("2026-11-13T17:18:37Z");

const chip = (problem: Problem) =>
  render(
    <WithProblem problem={problem} role="ok">
      <span>Running</span>
    </WithProblem>
  ).container.querySelector<HTMLElement>("[data-problem]")!;

describe("a problem nobody could check again", () => {
  /**
   * Shot r7-13: pods refused, and the row and the peek drew green "Running"
   * as if the probe had recovered. Fails if a kept problem is drawn in its
   * old tone, without "not rechecked", or without why and since when.
   */
  it("says not rechecked in amber, and why and since when on hover", () => {
    const mark = chip({
      tone: "err",
      n: 1,
      title: "Unhealthy: Readiness probe failed",
      stale: { at: AT, refused: true },
    });
    expect(mark.dataset.problem).toBe("warn");
    expect(mark).toHaveAttribute("data-problem-stale");
    expect(mark.querySelector("[data-problem-mark]")).toHaveTextContent(
      /^1 problem1·not rechecked·$/
    );
    expect(mark.title).toBe(
      `Not rechecked: the cluster refused the read that would check this again. Last known at ${formatWhen(AT, "clock")}.\nUnhealthy: Readiness probe failed`
    );
  });

  /** Fails if a failed read is called a refusal, or a kept Service row with no date loses its hover. */
  it("says the read failed where it failed, and last known where it has no date", () => {
    expect(
      chip({
        tone: "warn",
        n: 1,
        title: "x",
        stale: { at: AT, refused: false },
      }).title
    ).toMatch(/^Not rechecked: the read that would check this again failed/);
    expect(
      chip({
        tone: "warn",
        n: 1,
        title: "x",
        stale: { at: null, refused: false },
      }).title
    ).toMatch(/^Last known: a read behind this row failed/);
  });

  /** Fails if a current problem starts saying it was not rechecked. */
  it("draws a current problem in its own tone with nothing added", () => {
    const mark = chip({ tone: "err", n: 2, title: "CrashLoopBackOff" });
    expect(mark.dataset.problem).toBe("err");
    expect(mark).not.toHaveAttribute("data-problem-stale");
    expect(mark).not.toHaveTextContent("not rechecked");
    expect(mark.title).toBe("CrashLoopBackOff");
  });
});

describe("where the mark drops its noun", () => {
  /**
   * Shot r7-10: "⚠ 1 ·" with no noun in a cell that had room for it; the
   * switch sat at 11rem, wider than the mark and "✓ Running" need. Fails if
   * the switch drifts from the room the whole mark and a seven-letter status
   * badge take, or if the class stops being the measured one.
   */
  it("keeps the noun down to the whole mark beside a seven-letter status", () => {
    expect(PROBLEM_MARK_ROOM_PX).toBe(
      PROBLEM_MARK_PX + 6 + statusCellPx(7) - CELL_PADS_PX
    );
    expect(PROBLEM_MARK_ROOM_PX).toBeLessThan(11 * 16);
    chip({ tone: "warn", n: 1, title: "x" });
    expect(screen.getByText("1 problem").className).toBe(
      `@max-[${PROBLEM_MARK_ROOM_PX}px]:hidden`
    );
  });

  /** Fails if "not rechecked" widens the mark without moving where it gives up its noun. */
  it("gives up the noun earlier where the mark also says not rechecked", () => {
    expect(PROBLEM_STALE_ROOM_PX).toBe(PROBLEM_MARK_ROOM_PX + PROBLEM_STALE_PX);
    chip({ tone: "warn", n: 1, title: "x", stale: { at: AT, refused: true } });
    expect(screen.getByText("1 problem").className).toBe(
      `@max-[${PROBLEM_STALE_ROOM_PX}px]:hidden`
    );
  });
});
