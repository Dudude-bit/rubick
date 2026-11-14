import type { MapTone } from "./types";

/** A node's border by its tone; `unknown` is the dashed not-checked ring. */
export const NODE_BORDER: Record<MapTone, string> = {
  ok: "border-ok/50",
  warn: "border-warn/60",
  err: "border-err/70",
  mute: "border-hair",
  unknown: "border-dashed border-fg-fnt/70",
};

export const TONE_TEXT: Record<MapTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  mute: "text-fg-fnt",
  unknown: "text-fg-fnt",
};

/** An edge's stroke, drawn in `currentColor`. */
export const EDGE_TEXT: Record<MapTone, string> = {
  ok: "text-fg-fnt/50",
  warn: "text-warn/70",
  err: "text-err/80",
  mute: "text-fg-fnt/40",
  unknown: "text-fg-fnt/60",
};
