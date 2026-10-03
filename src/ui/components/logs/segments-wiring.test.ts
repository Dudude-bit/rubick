import { describe, expect, it } from "vitest";
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

/**
 * The runs cross the boundary through hand-written object literals, and the
 * field is optional on every type it passes through — so dropping the line
 * is not a type error and nothing else notices. This is the repository's
 * recurring defect: one fact, several readers, wired in one place and
 * forgotten in the next. Each of these fails if its mapping loses the runs.
 * The third reader, Loki's page, is guarded beside its own client, where a
 * vendor may be named.
 */
describe("the runs survive every hop across the boundary", () => {
  it("history keeps them on the way to a streamed line", async () => {
    const { toStreamedLines } = await import("./hooks/useLogHistory");
    const [line] = toStreamedLines(
      {
        truncated: false,
        limit: 1000,
        streams: 1,
        labelsTried: [],
        lines: [
          {
            cursor: "1",
            epoch: 0,
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
        ],
      },
      { current: 1 }
    );
    expect(line!.segments).toEqual(runs);
  });

  it("the live stream keeps them on the way into the buffer", async () => {
    const { toStreamedLine } = await import("./hooks/useLogStream");
    const line = toStreamedLine(
      {
        message: "ERROR disk full",
        timestamp: "2026-09-06T00:00:00.000Z",
        level: "error",
        format: "plain",
        fields: null,
        raw: "ERROR disk full",
        segments: runs,
      },
      { id: 1, epoch: 0, pod: "pod", container: "app", namespace: "default" }
    );
    expect(line.segments).toEqual(runs);
  });
});
