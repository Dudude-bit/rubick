import type { severityTone } from "@/lib/alerts";

type Tone = ReturnType<typeof severityTone>;

/**
 * The colours a severity earns, in one place because two surfaces wear them.
 *
 * The panel draws a chip and the banner draws a whole card, and they were
 * two different answers to one question: the panel coloured the chip by
 * severity while the banner stayed amber for everything, so a `critical`
 * arrived looking exactly like an `info`. Both maps are total, so a new tone
 * is a compiler error rather than a silently grey badge.
 */
export const SEVERITY_CHIP: Record<Tone, string> = {
  err: "border-err/45 text-err",
  warn: "border-warn/45 text-warn",
  info: "border-info/45 text-info",
  neutral: "border-hair text-fg-mut",
};

/** The banner's frame, its wash and the words in its header. */
export const SEVERITY_BANNER: Record<Tone, { box: string; head: string }> = {
  err: { box: "border-err/40 bg-err/[0.07]", head: "text-err" },
  warn: { box: "border-warn/40 bg-warn/[0.07]", head: "text-warn" },
  info: { box: "border-info/40 bg-info/[0.07]", head: "text-info" },
  neutral: { box: "border-hair bg-raised", head: "text-fg-mut" },
};

/** The quote's rule, which follows the header rather than the frame. */
export const SEVERITY_QUOTE: Record<Tone, string> = {
  err: "border-err/40",
  warn: "border-warn/40",
  info: "border-info/40",
  neutral: "border-hair",
};
