import type { Point } from "@/lib/map-layout";
import {
  subLine,
  type GraphEdge,
  type GraphGroup,
  type GraphNode,
  type MapTone,
} from "./types";
import type { Box } from "./useLayout";
import { routePath } from "./visible";

/** The theme's colours, as CSS colour strings. */
export interface SvgColours {
  canvas: string;
  raise: string;
  fg: string;
  faint: string;
  hair: string;
  tones: Record<MapTone, string>;
}

const FALLBACK = "hsl(0 0% 50%)";

/** The role tokens as the window paints them now, so the file reads in the theme it was taken in. */
export function themeColours(
  root: Element = document.documentElement
): SvgColours {
  const style = getComputedStyle(root);
  const token = (name: string) => {
    const value = style.getPropertyValue(`--${name}`).trim();
    return value ? `hsl(${value})` : FALLBACK;
  };
  return {
    canvas: token("canvas"),
    raise: token("raise"),
    fg: token("fg"),
    faint: token("fg-fnt"),
    hair: token("hair"),
    tones: {
      ok: token("ok"),
      warn: token("warn"),
      err: token("err"),
      mute: token("fg-fnt"),
      unknown: token("fg-fnt"),
    },
  };
}

/**
 * Widths of one character, as a share of the font size, that a cut is
 * judged by. ponytail: an average, not a measurement; an image that must
 * fit a wide-lettered name exactly would measure with a canvas.
 */
const MONO_CHAR = 11.5 * 0.6;
const SANS_CHAR = 10 * 0.56;
const NOTE_CHAR = 11 * 0.6;

/** `text` cut to `room` pixels, an ellipsis where it was. */
function cut(text: string, room: number, char: number): string {
  const fits = Math.floor(room / char);
  return text.length <= fits ? text : `${text.slice(0, fits - 1)}…`;
}

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export interface SvgInput {
  groups: { group: GraphGroup; box: Box; summary: string }[];
  /** Absolute positions. */
  nodes: { node: GraphNode; at: Point; width: number; height: number }[];
  /** With the layout's route where it laid the edge out. */
  edges: {
    edge: GraphEdge;
    from: Point;
    to: Point;
    route?: readonly Point[];
  }[];
  colours: SvgColours;
  /** What the page says above the map about what it could not read, one line each. */
  notes?: readonly string[];
}

/** The map as it stands, drawn from what it holds rather than read off the screen. */
export function mapSvg({
  groups,
  nodes,
  edges,
  colours,
  notes = [],
}: SvgInput): string {
  const boxes = [
    ...groups.map(({ box }) => box),
    ...nodes.map(({ at, width, height }) => ({ ...at, width, height })),
  ];
  // As wide as the longest note too: one past the edge is cut off.
  const right =
    Math.max(
      0,
      ...boxes.map((b) => b.x + b.width),
      ...notes.map((note) => note.length * NOTE_CHAR)
    ) + 24;
  const bottom = Math.max(0, ...boxes.map((b) => b.y + b.height)) + 24;
  const top = -24 - notes.length * 16;
  const parts: string[] = [
    `<defs><pattern id="refused" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><line x1="0" y1="0" x2="0" y2="9" stroke="${colours.hair}"/></pattern></defs>`,
    `<rect x="-24" y="${top}" width="${right + 24}" height="${bottom - top}" fill="${colours.canvas}"/>`,
    ...notes.map(
      (note, at) =>
        `<text x="0" y="${top + 16 * (at + 1)}" font-size="11" fill="${colours.tones.warn}">${escape(note)}</text>`
    ),
  ];
  for (const { group, box, summary } of groups) {
    // As on screen: a namespace nothing could be read in is hatched and
    // says why, open or not, and a card nobody could check is dashed.
    const dashed =
      group.refused || (group.collapsed && group.tone === "unknown");
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" fill="${group.refused ? "url(#refused)" : "none"}" stroke="${group.collapsed ? colours.tones[group.tone] : colours.hair}"${dashed ? ' stroke-dasharray="3 3"' : ""}/>`,
      `<text x="${box.x + 12}" y="${box.y + 22}" font-size="12" font-weight="600" fill="${colours.fg}">${escape(group.label)}</text>`
    );
    if ((group.collapsed || group.refused) && summary)
      parts.push(
        `<text x="${box.x + 12}" y="${box.y + 44}" font-size="10.5" fill="${colours.faint}">${escape(summary)}</text>`
      );
  }
  for (const { edge, from, to, route } of edges) {
    const bend = (to.x - from.x) / 2;
    const d =
      route && route.length >= 2
        ? routePath(route).path
        : `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
    parts.push(
      `<path d="${d}" fill="none" stroke="${colours.tones[edge.tone]}" stroke-width="${1 + 3 * (edge.weight ?? 0)}"${edge.tone === "unknown" ? ' stroke-dasharray="3 3"' : ""}/>`
    );
  }
  for (const { node, at, width, height } of nodes) {
    // Cut to the box as the canvas cuts with an ellipsis; the whole name
    // stays in the node's title.
    const room = width - 16;
    parts.push(
      `<g><title>${escape([node.label, subLine(node)].filter(Boolean).join("\n"))}</title>`,
      `<rect x="${at.x}" y="${at.y}" width="${width}" height="${height}" rx="5" fill="${colours.raise}" stroke="${colours.tones[node.tone]}"${node.tone === "unknown" ? ' stroke-dasharray="3 3"' : ""}/>`,
      `<text x="${at.x + 8}" y="${at.y + 19}" font-size="11.5" font-family="monospace" fill="${colours.fg}">${escape(cut(node.label, room, MONO_CHAR))}</text>`,
      `<text x="${at.x + 8}" y="${at.y + 34}" font-size="10" fill="${colours.faint}">${escape(cut(subLine(node), room, SANS_CHAR))}</text>`,
      `</g>`
    );
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-24 ${top} ${right + 24} ${bottom - top}" width="${right + 24}" height="${bottom - top}" font-family="sans-serif">`,
    ...parts,
    `</svg>`,
  ].join("\n");
}
