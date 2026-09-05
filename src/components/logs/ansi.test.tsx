import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { LogLine, StyledSegment, TextStyle } from "@/generated/types";
import { contrast, type Rgb } from "@/lib/color";
import {
  cssColor,
  messageSegments,
  splitByQuery,
  styleToCss,
  tailSegments,
} from "./ansi";
import { AnsiText } from "./AnsiText";

const plain: TextStyle = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
};

const line = (partial: Partial<LogLine>): LogLine => ({
  timestamp: null,
  message: "",
  level: null,
  format: "plain",
  fields: null,
  raw: "",
  pod: "pod",
  container: "app",
  namespace: "default",
  ...partial,
});

/** The canvases as `src/index.css` paints them, for the contrast checks. */
const DARK_CANVAS: Rgb = [31, 33, 36];
const LIGHT_CANVAS: Rgb = [251, 250, 248];

const channels = (css: string) => css.match(/\d+/g)!.map(Number) as Rgb;

describe("cssColor", () => {
  /// A hard-coded red would be invisible on one of the two canvases;
  /// the token is what lets each theme pick its own.
  it("a named colour is the theme's token, bright ones the upper eight", () => {
    expect(cssColor({ kind: "named", index: 1 }, true)).toBe(
      "hsl(var(--ansi-1))"
    );
    expect(cssColor({ kind: "named", index: 9 }, false)).toBe(
      "hsl(var(--ansi-9))"
    );
    expect(cssColor({ kind: "indexed", index: 12 }, true)).toBe(
      "hsl(var(--ansi-12))"
    );
  });

  /// A colour that already reads on the canvas is the program's colour,
  /// untouched.
  it("a readable cube or truecolor colour is kept as written", () => {
    expect(cssColor({ kind: "indexed", index: 46 }, true)).toBe("rgb(0 255 0)");
    expect(cssColor({ kind: "rgb", r: 0, g: 0, b: 128 }, false)).toBe(
      "rgb(0 0 128)"
    );
  });

  /// Truecolor black on the dark canvas and truecolor white on the light
  /// one are what a program's own dark-terminal or light-terminal colours
  /// look like on the other kind of canvas. They have to read anyway.
  it("an unreadable colour is pulled toward the opposite of the canvas until it reads", () => {
    const black = cssColor({ kind: "rgb", r: 0, g: 0, b: 0 }, true);
    const navy = cssColor({ kind: "indexed", index: 17 }, true);
    const white = cssColor({ kind: "rgb", r: 255, g: 255, b: 255 }, false);
    const grey = cssColor({ kind: "indexed", index: 255 }, false);
    expect(contrast(channels(black), DARK_CANVAS)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels(navy), DARK_CANVAS)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels(white), LIGHT_CANVAS)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels(grey), LIGHT_CANVAS)).toBeGreaterThanOrEqual(4.5);
    // Navy stays blue: the lift keeps the hue the program chose.
    const [r, , b] = channels(navy);
    expect(b).toBeGreaterThan(r);
  });
});

describe("styleToCss", () => {
  /// White text on a white background is what a naive "background 7"
  /// would produce on the light canvas; the text has to come from the
  /// canvas, which every palette colour was chosen to read against.
  it("a background with no foreground draws the text in the canvas colour", () => {
    expect(
      styleToCss({ ...plain, bg: { kind: "named", index: 7 } }, true)
    ).toEqual({
      color: "hsl(var(--canvas))",
      background: "hsl(var(--ansi-7))",
    });
  });

  /// Inverse with nothing set is "swap the defaults": fg on canvas
  /// becomes canvas on fg, or an inverse-video banner vanishes.
  it("inverse swaps the two, with the canvas and the foreground standing in for what is unset", () => {
    expect(
      styleToCss(
        { ...plain, inverse: true, fg: { kind: "named", index: 2 } },
        true
      )
    ).toEqual({
      color: "hsl(var(--canvas))",
      background: "hsl(var(--ansi-2))",
    });
    expect(styleToCss({ ...plain, inverse: true }, true)).toEqual({
      color: "hsl(var(--canvas))",
      background: "hsl(var(--fg))",
    });
  });

  /// Two `textDecoration` assignments would keep only the last one.
  it("underline and strike share one declaration", () => {
    expect(
      styleToCss({ ...plain, underline: true, strike: true }, true)
    ).toEqual({
      textDecoration: "underline line-through",
    });
  });
});

describe("messageSegments", () => {
  const segments: StyledSegment[] = [
    { text: "2024-01-01T00:00:00Z " },
    { text: "INFO", style: { ...plain, fg: { kind: "named", index: 2 } } },
    { text: " started" },
  ];

  /// The parser cut the timestamp off the front; the runs the message
  /// keeps are the ones after the cut, split mid-run where the cut falls.
  it("a plain message keeps the tail of the line's runs", () => {
    const log = line({
      raw: "2024-01-01T00:00:00Z INFO started",
      message: "INFO started",
      segments,
    });
    expect(messageSegments(log)).toEqual(segments.slice(1));
    expect(tailSegments(segments, 5)).toEqual([{ text: "arted" }]);
  });

  /// klog and logback messages are the tail of the line too.
  it("a klog message keeps the tail of the line's runs", () => {
    const raw = "I0101 00:00:00.000000 1 main.go:1] started";
    const log = line({
      raw,
      message: "started",
      format: "klog",
      segments: [{ text: raw, style: { ...plain, bold: true } }],
    });
    expect(messageSegments(log)).toEqual([
      { text: "started", style: { ...plain, bold: true } },
    ]);
  });

  /// A message lifted out of a field is not a piece of the line even when
  /// the line ends with the same characters: `msg=hello other=hello`
  /// would borrow the second field's colours for the first.
  it("a message lifted out of a structured field has no runs", () => {
    const red = { ...plain, fg: { kind: "named", index: 1 } as const };
    const green = { ...plain, fg: { kind: "named", index: 2 } as const };
    const log = line({
      raw: "msg=hello other=hello",
      message: "hello",
      format: "logfmt",
      segments: [
        { text: "msg=" },
        { text: "hello", style: red },
        { text: " other=" },
        { text: "hello", style: green },
      ],
    });
    expect(messageSegments(log)).toBeNull();
    expect(messageSegments(line({ raw: "x", message: "x" }))).toBeNull();
  });
});

describe("splitByQuery", () => {
  /// The odd parts are the matches, whatever their case; a query that is
  /// regex syntax is text to find, not a pattern.
  it("cuts at every match and treats the query as text", () => {
    expect(splitByQuery("Disk full, disk full", "disk")).toEqual([
      "",
      "Disk",
      " full, ",
      "disk",
      " full",
    ]);
    expect(splitByQuery("a.b", ".")).toEqual(["a", ".", "b"]);
    expect(splitByQuery("text", "")).toEqual(["text"]);
  });
});

describe("AnsiText", () => {
  const segments: StyledSegment[] = [
    {
      text: "ERR",
      style: { ...plain, bold: true, fg: { kind: "named", index: 1 } },
    },
    { text: " disk full" },
  ];

  /// Unstyled text stays unstyled, so it inherits the row's level tint; a
  /// styled run is a span carrying only what the program set.
  it("styles only the runs the program styled", () => {
    const { container } = render(<AnsiText segments={segments} />);
    const styled = container.querySelectorAll("span[style]");
    expect(styled).toHaveLength(1);
    expect(styled[0].textContent).toBe("ERR");
    expect((styled[0] as HTMLElement).style.color).toBe("hsl(var(--ansi-1))");
    expect((styled[0] as HTMLElement).style.fontWeight).toBe("600");
    expect(container.textContent).toBe("ERR disk full");
  });

  /// Typing a search must not turn a coloured line grey: the match is
  /// marked inside the run, the run keeps its colour.
  it("marks the search inside the runs and keeps their colours", () => {
    const { container } = render(<AnsiText segments={segments} query="disk" />);
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("disk");
    expect(container.querySelectorAll("span[style]")).toHaveLength(1);
    expect(container.textContent).toBe("ERR disk full");
  });
});
