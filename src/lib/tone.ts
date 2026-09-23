/**
 * How a fact reads, and the one place each reading becomes a colour.
 *
 * Total maps, not ternaries: `tone === "err" ? … : "text-ok"` paints any
 * state added later green, and a `Record` refuses to compile instead.
 */
export type Tone = "ok" | "warn" | "err" | "info" | "unknown";

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  info: "text-info",
  unknown: "text-fg-fnt",
};

export const TONE_BG: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-info",
  unknown: "bg-fg-fnt",
};

export const TONE_BORDER: Record<Tone, string> = {
  ok: "border-ok",
  warn: "border-warn",
  err: "border-err",
  info: "border-info",
  unknown: "border-fg-fnt",
};
