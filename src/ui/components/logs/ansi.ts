import type { CSSProperties } from "react";
import type {
  AnsiColor,
  LogLine,
  StyledSegment,
  TextStyle,
} from "@/generated/types";
import { luminance, type Rgb } from "@/lib/color";

const token = (index: number) => `hsl(var(--ansi-${index}))`;

/**
 * The sixteen named colours are theme tokens, not the colours a terminal
 * would use: black on this dark canvas and yellow on the light one are
 * invisible, and a program that picked "red" meant "red", not the hex
 * its author's terminal happened to render. The cube and truecolor keep
 * the colour the program chose, pulled toward the canvas's opposite
 * just far enough to read on it. (The identity hues in `index.css` fix
 * saturation and lightness instead, because a hashed hue carries no
 * lightness worth keeping; a program's truecolor does.)
 */
export function cssColor(color: AnsiColor, dark: boolean): string {
  if (color.kind === "named") return token(color.index & 15);
  if (color.kind === "rgb") return readable([color.r, color.g, color.b], dark);
  if (color.index < 16) return token(color.index);
  if (color.index >= 232) {
    const grey = 8 + (color.index - 232) * 10;
    return readable([grey, grey, grey], dark);
  }
  const cube = color.index - 16;
  const step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return readable(
    [
      step(Math.floor(cube / 36)),
      step(Math.floor(cube / 6) % 6),
      step(cube % 6),
    ],
    dark
  );
}

/**
 * 4.5:1 against the canvas, as WCAG counts it for 12px text. The dark
 * canvas has a relative luminance near 0.015 and the light one near
 * 0.96, so these are the luminances a colour has to reach on each.
 */
const MIN_LUMINANCE_ON_DARK = 0.25;
const MAX_LUMINANCE_ON_LIGHT = 0.165;

/** The colour, mixed toward white or black until it reads on the canvas. */
function readable(rgb: Rgb, dark: boolean): string {
  const ok = (c: Rgb) =>
    dark
      ? luminance(c) >= MIN_LUMINANCE_ON_DARK
      : luminance(c) <= MAX_LUMINANCE_ON_LIGHT;
  let mixed = rgb;
  if (!ok(rgb)) {
    const target = dark ? 255 : 0;
    const mix = (t: number): Rgb =>
      rgb.map((v) => Math.round(v + (target - v) * t)) as Rgb;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mix(mid))) hi = mid;
      else lo = mid;
    }
    mixed = mix(hi);
  }
  return `rgb(${mixed[0]} ${mixed[1]} ${mixed[2]})`;
}

/**
 * Text on a background draws in the canvas colour: every palette colour is
 * tuned to read against the canvas, so the canvas reads against every
 * palette colour. That invariant is the only one available here — a pair
 * the program chose was tuned twice against the canvas and not once
 * against each other, so `\e[37m\e[41m` (white on red, how chalk and most
 * Java formatters write a banner) lands at 1.19:1 on the light theme, and
 * 464 of the 480 named pairs fall under 3:1 on one canvas or the other.
 *
 * So a background wins the pair and the foreground the program asked for
 * is dropped. It loses one of the two colours; keeping both loses the
 * words. Inverse is the same rule after the swap.
 */
export function styleToCss(style: TextStyle, dark: boolean): CSSProperties {
  const css: CSSProperties = {};
  let fg = style.fg ? cssColor(style.fg, dark) : undefined;
  let bg = style.bg ? cssColor(style.bg, dark) : undefined;
  if (style.inverse) {
    [fg, bg] = [bg ?? "hsl(var(--canvas))", fg ?? "hsl(var(--fg))"];
  }
  if (bg) {
    fg = "hsl(var(--canvas))";
  }
  if (fg) css.color = fg;
  if (bg) css.background = bg;
  if (style.bold) css.fontWeight = 600;
  if (style.dim) css.opacity = 0.7;
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
 * The message's runs, or nothing when they cannot be known. Only for the
 * formats whose message is the tail of the line. A message lifted out of
 * a JSON or logfmt field is not a piece of the line even when the line
 * happens to end with the same characters (`msg=hello other=hello`), so
 * it keeps the level tint the row gives it instead.
 */
export function messageSegments(log: LogLine): StyledSegment[] | null {
  if (!log.segments) return null;
  if (log.format === "json" || log.format === "logfmt") return null;
  if (!log.raw.endsWith(log.message)) return null;
  return tailSegments(log.segments, log.message.length);
}

/**
 * `text` cut at every case-insensitive occurrence of `query`; the odd
 * indices are the matches. A query that is not a valid pattern after
 * escaping is not a query: the whole text comes back as one piece.
 */
export function splitByQuery(text: string, query: string): string[] {
  if (!query) return [text];
  try {
    return text.split(
      new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi")
    );
  } catch {
    return [text];
  }
}
