import { useEffect, useRef, useState } from "react";

import { useToast } from "@/components/ui/use-toast";
import { termLabel, type QueryTerm } from "../types";
import { useT } from "@/i18n/useT";

/**
 * How long the chips are allowed to keep changing before the stream is
 * asked to restart.
 *
 * A reader promoting one term usually promotes the next one straight
 * after, and every restart costs a gap in the log where the old stream
 * is closed and the new one has not attached yet. Long enough to swallow
 * a run of clicks, short enough that a single flip does not feel ignored.
 */
export const INTAKE_SETTLE_MS = 500;

/** Joined on a byte no label can hold: a text term may contain spaces. */
const keyOf = (terms: QueryTerm[]) => terms.map(termLabel).join("\u0000");

/**
 * The intake set the stream is actually running with, and the one
 * sentence a flip has to say.
 *
 * The chips turn blue on the click — the mode is the reader's, not the
 * backend's — while this holds the value still until the flipping stops,
 * so three flips in a row are one restart and not three.
 *
 * Demoting is the case that needs words. Nothing on screen changes when
 * a term goes back to being a query (both modes filter the view, so the
 * same lines are shown either way), and the fact a reader would
 * otherwise assume wrong is that the lines discarded while it was intake
 * are gone for good. It is said as a toast rather than beside the chip:
 * the query box is one 24px row that must not grow, an inline notice
 * would reflow the virtualised list under the reader, and the message is
 * about a transition rather than a state — a banner still sitting there
 * a minute later would describe something that already finished. The
 * same sentence is on the toggle's tooltip before the click, so it is
 * available to anyone who wants to read it again.
 */
export function useIntake(terms: QueryTerm[]): QueryTerm[] {
  const t = useT();
  const { toast } = useToast();
  const key = keyOf(terms);
  const [applied, setApplied] = useState<{ key: string; terms: QueryTerm[] }>(
    () => ({ key, terms })
  );

  useEffect(() => {
    if (key === applied.key) return;
    const timer = setTimeout(
      () => setApplied({ key, terms }),
      INTAKE_SETTLE_MS
    );
    return () => clearTimeout(timer);
  }, [key, terms, applied.key]);

  // What the last restart actually changed, compared with the one before
  // it — not with what the chips happen to say now, which may already
  // have moved on inside the settle window.
  const spoken = useRef<QueryTerm[] | null>(null);
  useEffect(() => {
    const previous = spoken.current;
    spoken.current = applied.terms;
    if (previous === null) return;

    const before = new Set(previous.map(termLabel));
    const after = new Set(applied.terms.map(termLabel));
    const demoted = [...before].filter((label) => !after.has(label));
    const promoted = [...after].filter((label) => !before.has(label));

    // Demoting wins when a batch of flips did both: it carries the fact
    // that is not visible anywhere on screen.
    if (demoted.length > 0) {
      toast({
        title: t("action", "termsAreQueryAgain", {
          n: demoted.length,
          list: list(demoted),
        }),
        description: t("action", "termsAreQueryAgainHint"),
      });
    } else if (promoted.length > 0) {
      toast({
        title: t("action", "keepingOnly", { list: list(promoted) }),
        description: t("action", "keepingOnlyHint"),
      });
    }
  }, [applied, t, toast]);

  return applied.terms;
}

/** `a`, `a and b`, `a, b and c`. */
function list(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
