import { describe, expect, it, vi } from "vitest";
import type { StyledSegment } from "@/generated/types";

const runs: StyledSegment[] = [
  {
    text: "ERROR disk full",
    style: {
      fg: { kind: "named", index: 1 },
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      strike: false,
    },
  },
];

vi.mock("@/lib/commands", () => ({
  commands: {
    lokiQueryRange: vi.fn(async () => ({
      lines: [
        {
          ts: "1",
          line: {
            timestamp: "2026-09-06T00:00:00.000Z",
            message: "ERROR disk full",
            raw: "ERROR disk full",
            segments: runs,
            pod: "pod",
            container: "app",
            namespace: "default",
            level: "error",
            format: "plain",
            fields: null,
          },
        },
      ],
      truncated: false,
    })),
  },
}));

/**
 * The runs cross the boundary through a hand-written literal and are
 * optional on both sides, so dropping the line is not a type error and
 * nothing else notices. Would break if the page mapping lost them.
 */
describe("a page from Loki", () => {
  it("keeps the runs on the way to a history line", async () => {
    const { logHistory } = await import("./client");
    const page = await logHistory({
      scope: { kind: "pod", namespace: "default", pod: "pod" },
      range: "1h",
    });
    expect(page.lines[0]!.segments).toEqual(runs);
  });
});
