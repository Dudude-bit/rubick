import type { Backing } from "@/integrations";
import type { T } from "@/i18n/useT";
import { describeStop, stopMood, type StopMood } from "@/lib/connections";
import { doorDoubtWords } from "@/lib/policy-door";

/** A backend's stop as the chain colours it: only a fault is red. */
const STOP_TEXT: Record<StopMood, string> = {
  fault: "text-err",
  coming: "text-info",
  idle: "text-fg-mut",
  unchecked: "text-fg-mut",
};

/** What stands behind a backendRef, as the Rules tab's last column says it. */
export function behindIt(
  state: Backing | null,
  t: T
): { text: string; className: string } {
  if (state === null)
    return { text: t("cluster", "markUnchecked"), className: "text-fg-fnt" };
  if (!state.known)
    return { text: t("action", "readingInline"), className: "text-fg-fnt" };
  if (state.stop)
    return {
      text: describeStop(state.stop, t).title,
      className: STOP_TEXT[stopMood(state.stop)],
    };
  if (state.doubt)
    return {
      text: doorDoubtWords(state.doubt, t).title,
      className: "text-fg-mut",
    };
  if (state.service?.type === "ExternalName")
    return {
      text: t("empty", "resolvesElsewhereExternal"),
      className: "text-fg-mut",
    };
  const draining =
    state.draining > 0 ? t("count", "nDraining", { n: state.draining }) : null;
  if (state.ready === 0 && draining)
    return { text: draining, className: "text-warn" };
  return {
    text: [t("count", "nReady", { n: state.ready }), draining]
      .filter(Boolean)
      .join(", "),
    className: "text-ok",
  };
}
