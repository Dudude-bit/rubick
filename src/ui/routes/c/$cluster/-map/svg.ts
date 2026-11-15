import type { Point } from "@/lib/map-layout";
import {
  subLine,
  type GraphEdge,
  type GraphGroup,
  type GraphNode,
  type MapTone,
} from "./types";
import type { Box } from "./useLayout";

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
  edges: { edge: GraphEdge; from: Point; to: Point }[];
  colours: SvgColours;
}

/** The map as it stands, drawn from what it holds rather than read off the screen. */
export function mapSvg({ groups, nodes, edges, colours }: SvgInput): string {
  const boxes = [
    ...groups.map(({ box }) => box),
    ...nodes.map(({ at, width, height }) => ({ ...at, width, height })),
  ];
  const right = Math.max(0, ...boxes.map((b) => b.x + b.width)) + 24;
  const bottom = Math.max(0, ...boxes.map((b) => b.y + b.height)) + 24;
  const parts: string[] = [
    `<rect x="-24" y="-24" width="${right + 24}" height="${bottom + 24}" fill="${colours.canvas}"/>`,
  ];
  for (const { group, box, summary } of groups) {
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="8" fill="none" stroke="${group.collapsed ? colours.tones[group.tone] : colours.hair}"/>`,
      `<text x="${box.x + 12}" y="${box.y + 22}" font-size="12" font-weight="600" fill="${colours.fg}">${escape(group.label)}</text>`
    );
    if (group.collapsed && summary)
      parts.push(
        `<text x="${box.x + 12}" y="${box.y + 44}" font-size="10.5" fill="${colours.faint}">${escape(summary)}</text>`
      );
  }
  for (const { edge, from, to } of edges) {
    const bend = (to.x - from.x) / 2;
    parts.push(
      `<path d="M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}" fill="none" stroke="${colours.tones[edge.tone]}" stroke-width="${1 + 3 * (edge.weight ?? 0)}"${edge.tone === "unknown" ? ' stroke-dasharray="3 3"' : ""}/>`
    );
  }
  for (const { node, at, width, height } of nodes) {
    parts.push(
      `<rect x="${at.x}" y="${at.y}" width="${width}" height="${height}" rx="5" fill="${colours.raise}" stroke="${colours.tones[node.tone]}"${node.tone === "unknown" ? ' stroke-dasharray="3 3"' : ""}/>`,
      `<text x="${at.x + 8}" y="${at.y + 19}" font-size="11.5" font-family="monospace" fill="${colours.fg}">${escape(node.label)}</text>`,
      `<text x="${at.x + 8}" y="${at.y + 34}" font-size="10" fill="${colours.faint}">${escape(subLine(node))}</text>`
    );
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-24 -24 ${right + 24} ${bottom + 24}" width="${right + 24}" height="${bottom + 24}" font-family="sans-serif">`,
    ...parts,
    `</svg>`,
  ].join("\n");
}
