import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";

import { CircleDashed } from "lucide-react";

import { kindMark } from "@/lib/resource-identity";
import { KindRail } from "./KindRail";
import { MAP_KINDS } from "./model";

describe("the map's kind rail", () => {
  /**
   * Every row wore the dashed circle of a kind the app does not know, so the
   * rail's kinds could only be told apart by their words. Fails if a built-in
   * row loses its own glyph.
   */
  it("marks each kind with its own glyph", () => {
    render(
      <KindRail
        rows={["Deployment", "PodDisruptionBudget"].map((kind) => ({
          kind,
          count: 1,
          used: null,
          reading: { says: "live" },
          hidden: false,
        }))}
        onToggle={() => {}}
      />
    );
    const glyphs = screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector("label")!.previousElementSibling);
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) {
      expect(glyph).not.toBeNull();
      expect(glyph).not.toHaveClass("lucide-circle-dashed");
    }
    expect(glyphs[0]!.getAttribute("class")).not.toBe(
      glyphs[1]!.getAttribute("class")
    );
  });

  /** Fails if a kind the map draws has no glyph of its own and would wear the mark of a kind the app does not know. */
  it("has a glyph of its own for every kind the map draws", () => {
    const unmarked = MAP_KINDS.filter(
      (kind) => kindMark({ kind, crd: undefined }).Icon === CircleDashed
    );
    expect(unmarked).toEqual([]);
  });
});
