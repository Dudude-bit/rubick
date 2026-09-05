/**
 * What a detail page declares about a tab, beyond the words in it.
 *
 * Two rules, expressed as two unions rather than as a lookup table keyed by
 * label. A table of thirty labels is a thing to keep in sync with eighteen
 * pages; a union is a thing the compiler makes each page answer.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { failingCondition } from "@/lib/condition-health";
import { statusRole } from "@/lib/status-role";
import type { ConditionInfo, PodInfo } from "@/generated/types";

/**
 * Rule one: a tab names a thing, or it names a view.
 *
 * `kind` is Containers, Pods, Instances, Events — a tab that opens onto
 * objects of a kind the app already draws elsewhere, so it takes that kind's
 * glyph and hue, active or not: clicking `Pods` on a Deployment must meet the
 * same cube that was clicked in the sidebar.
 *
 * `view` is Overview, Logs, Conditions, YAML, Template — a way of looking at
 * *this* object. Functional glyph, no hue: it is a verb rather than a thing,
 * and a hue would claim it is a resource.
 */
export type DetailTabGlyph =
  { names: "kind"; kind: string } | { names: "view"; icon: LucideIcon };

/**
 * Rule two: a tab earns a mark only when the mark changes which tab is
 * clicked. Three cases, and the union is what stops there being a fourth.
 *
 * One at a time, deliberately: a pod whose containers are counted *and*
 * failing shows the failure, because `3` beside a red dot is two answers to
 * a question that has one, and the count is the one nobody came for.
 */
export type DetailTabMark =
  /** The tab is a collection, and its size decides whether it is worth opening. */
  | { shows: "count"; of: number }
  /** Something inside is failing — `says` is what the tab tells a reader who cannot see the colour. */
  | { shows: "severity"; tone: "err" | "warn"; says: string }
  /** A session is attached inside. The only animated mark in the strip, so it means one thing. */
  | { shows: "live"; says: string };

export interface DetailTab {
  id: string;
  label: string;
  content: ReactNode;
  /** Required: a strip where some tabs carry a glyph and others do not is worse than none. */
  glyph: DetailTabGlyph;
  mark?: DetailTabMark | null;
  /**
   * What the tab is made of, which decides the space above it and who owns
   * the page's height.
   *
   * "sections" is the page rhythm: blocks with 22px of canvas between them
   * and 18px under the tab strip, in a page that flows and scrolls.
   * "surface" is one full-height pane bringing its own chrome — a log
   * viewer, an editor, a terminal — and it gets neither. The rhythm is
   * wrong because the first row of such a pane is a toolbar and canvas
   * above a toolbar reads as a hole; the height is the pane's because two
   * scrollbars over the same content make the reader scroll the outer one
   * to see the foot of the inner. A surface tab pins the page to the window
   * and takes every pixel the chrome above it does not.
   */
  kind?: "sections" | "surface";
}

/**
 * The constructors exist for inference, not for brevity. Most pages build
 * their tabs in a bare array literal, where `{ names: "kind", … }` widens to
 * `names: string` and stops being assignable to the union at all.
 */
export const kindGlyph = (kind: string): DetailTabGlyph => ({
  names: "kind",
  kind,
});

export const viewGlyph = (icon: LucideIcon): DetailTabGlyph => ({
  names: "view",
  icon,
});

/** Narrower than its siblings, so a strip that only allows counts can say so. */
export const countMark = (
  of: number
): Extract<DetailTabMark, { shows: "count" }> => ({
  shows: "count",
  of,
});

export const severityMark = (
  tone: "err" | "warn",
  says: string
): DetailTabMark => ({ shows: "severity", tone, says });

export const liveMark = (says: string): DetailTabMark => ({
  shows: "live",
  says,
});

/**
 * What a Conditions tab is worth marking with, on any of the six pages that
 * has one.
 *
 * `warn` rather than `err` even for `Ready=False`, because the container
 * state or the phase is always the louder and more specific answer — this is
 * a signpost to the rest of the story, not the story.
 */
export function conditionsMark(
  conditions: readonly ConditionInfo[] | undefined
): DetailTabMark | undefined {
  const failing = failingCondition(conditions ?? []);
  return failing
    ? severityMark("warn", `${failing.type} is ${failing.status}`)
    : undefined;
}

/**
 * What a Pods tab is worth marking with: how many, or which of them is down.
 *
 * A controller reports `2/3 ready` in its header and says nothing about
 * *which* pod, so the tab that holds the answer is where the fault belongs.
 */
export function podsMark(pods: readonly PodInfo[]): DetailTabMark {
  const failing = pods.filter(
    (pod) => statusRole(pod.status.display) === "err"
  );
  return failing.length > 0
    ? severityMark(
        "err",
        `${failing.length} of ${pods.length} failing · ${failing[0].name} is ${failing[0].status.display}`
      )
    : countMark(pods.length);
}

/**
 * Whether the open tab is a surface, which decides who owns the page's
 * height: the flow, or the pane.
 *
 * Only that. A page has nothing above the tab strip that a surface could
 * hide — its blocks are a tab of their own, and a tab is never hidden — so
 * a page whose every tab is a surface loses nothing by being pinned to the
 * window height.
 */
export function surfaceIsOpen(tabs: DetailTab[], activeTab: string): boolean {
  return tabs.find((tab) => tab.id === activeTab)?.kind === "surface";
}
