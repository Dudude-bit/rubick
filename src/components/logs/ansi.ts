import type { CSSProperties } from "react";
import type {
  AnsiColor,
  LogLine,
  StyledSegment,
  TextStyle,
} from "@/generated/types";

/**
 * The sixteen named colours are theme tokens, not the colours a terminal
 * would use: black on this dark canvas and yellow on the light one are
 * invisible, and a program that picked "red" meant "red", not the hex
 * its author's terminal happened to render. The cube and truecolor keep
 * the colour the program chose, lifted toward the foreground far enough
 * to read; how far is the theme's call (`--ansi-lift`).
 */
export function cssColor(color: AnsiColor): string {
  if (color.kind === "named") return `hsl(var(--ansi-${color.index & 15}))`;
  if (color.kind === "rgb") return lifted(color.r, color.g, color.b);
  if (color.index < 16) return `hsl(var(--ansi-${color.index}))`;
  if (color.index >= 232) {
    const grey = 8 + (color.index - 232) * 10;
    return lifted(grey, grey, grey);
  }
  const cube = color.index - 16;
  const step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return lifted(
    step(Math.floor(cube / 36)),
    step(Math.floor(cube / 6) % 6),
    step(cube % 6)
  );
}

const lifted = (r: number, g: number, b: number) =>
  `color-mix(in oklab, rgb(${r} ${g} ${b}), hsl(var(--fg)) var(--ansi-lift))`;

export function styleToCss(style: TextStyle): CSSProperties {
  const css: CSSProperties = {};
  let fg = style.fg ? cssColor(style.fg) : undefined;
  let bg = style.bg ? cssColor(style.bg) : undefined;
  if (style.inverse) {
    [fg, bg] = [bg ?? "hsl(var(--canvas))", fg ?? "hsl(var(--fg))"];
  }
  if (fg) css.color = fg;
  if (bg) css.background = bg;
  if (style.bold) css.fontWeight = 600;
  if (style.dim) css.opacity = 0.6;
  if (style.italic) css.fontStyle = "italic";
  const decoration = [
    style.underline && "underline",
    style.strike && "line-through",
  ].filter(Boolean);
  if (decoration.length > 0) css.textDecoration = decoration.join(" ");
  return css;
}

/**
 * The runs over the last `keep` characters of the line. The parser cuts
 * a timestamp off the front of a plain line; the message is what is left,
 * so its runs are the tail of the line's runs.
 */
export function tailSegments(
  segments: readonly StyledSegment[],
  keep: number
): StyledSegment[] {
  let drop = segments.reduce((n, s) => n + s.text.length, 0) - keep;
  const out: StyledSegment[] = [];
  for (const segment of segments) {
    if (drop >= segment.text.length) {
      drop -= segment.text.length;
      continue;
    }
    out.push(
      drop > 0 ? { ...segment, text: segment.text.slice(drop) } : segment
    );
    drop = 0;
  }
  return out;
}

/**
 * The message's runs, or nothing when they cannot be known. A message
 * lifted out of a JSON or logfmt field is not a piece of the line, so no
 * run maps onto it; it keeps the level tint the row gives it instead.
 */
export function messageSegments(log: LogLine): StyledSegment[] | null {
  if (!log.segments || !log.raw.endsWith(log.message)) return null;
  return tailSegments(log.segments, log.message.length);
}
