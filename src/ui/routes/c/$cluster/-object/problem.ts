import { useMemo } from "react";

import { useAttention } from "@/hooks/useAttention";
import type { AttentionItem } from "@/lib/attention";
import type { Finding } from "@/lib/governance";
import { builtInKindOf, type KindRef } from "@/lib/links";
import { isResourceType, ResourceType } from "@/lib/resource-registry";
import { itemsOfRow } from "./row-items";

export type ProblemTone = "err" | "warn";

/** What an object is in trouble for, past what its own status word says. */
export interface Problem {
  tone: ProblemTone;
  n: number;
  /** The worst one's sentence, for a hover. */
  title: string;
  /** Every finding behind it is the last answer of a read that has not answered since: when it came, and whether the reads since were refused. */
  stale?: { at: number | null; refused: boolean };
}

/** The room a row's "✕ 2 problems ·" mark takes beside its status word. */
export const PROBLEM_MARK_PX = Math.ceil(13 * 6.6);

/** The mark in a cell narrower than `PROBLEM_MARK_ROOM_PX`: glyph, count and dot. */
export const PROBLEM_MARK_COMPACT_PX = 36;

/** What "· not rechecked" adds to the mark, at its longest locale: "не перепроверено", 16 glyphs. */
export const PROBLEM_STALE_PX = Math.ceil(16 * 6.2) + 11;

/** The whole mark, its 6px gap and "✓ Running" (a 7-glyph badge): below this the mark drops its noun. */
export const PROBLEM_MARK_ROOM_PX =
  PROBLEM_MARK_PX + 6 + Math.ceil(7 * 6.6) + 14;

/** {@link PROBLEM_MARK_ROOM_PX} for a mark that also says it was not rechecked. */
export const PROBLEM_STALE_ROOM_PX = PROBLEM_MARK_ROOM_PX + PROBLEM_STALE_PX;

/** The loudest finding's tone and how many there are; `neutral` ones are facts, not trouble. */
export function problemOf(findings: readonly Finding[]): Problem | null {
  const trouble = findings.filter(({ tone }) => tone !== "neutral");
  const worst = trouble.find(({ tone }) => tone === "err") ?? trouble[0];
  return worst
    ? {
        tone: worst.tone === "err" ? "err" : "warn",
        n: trouble.length,
        title: worst.title,
      }
    : null;
}

/** The cluster's words closed as a sentence, so the words we add after them start one of their own. */
export function closedSentence(said: string): string {
  const text = said.trimEnd();
  return text === "" || /[.!?…]["'”»)\]]*$/.test(text) ? text : `${text}.`;
}

/** The names of the reads that failed, for the header to say the page is partly unread. */
export const unreadOf = (
  reads: readonly (readonly [name: string, error: unknown])[]
): string[] => reads.filter(([, error]) => error).map(([name]) => name);

/** The kinds an autoscaler or a budget governs, whose chip carries what governs them. */
export const GOVERNED: ReadonlySet<string> = new Set([
  ResourceType.Deployment,
  ResourceType.StatefulSet,
  ResourceType.DaemonSet,
]);

/**
 * The kind the shell's rows name an object by: a built-in's, or a custom
 * resource's own, as a pod's owner reference names it. A namesake of a
 * built-in is neither, so it never takes the built-in's rows.
 */
export function listedKindOf(ref: KindRef): string | null {
  if (ref.crd === null) return null;
  return builtInKindOf(ref) ?? (isResourceType(ref.kind) ? null : ref.kind);
}

/** The worst of the shell's problems one object's row carries, by its list's own rule (`itemsOfRow`). */
export const attentionProblem = (
  items: readonly AttentionItem[],
  kind: string,
  namespace: string | null,
  name: string
): Problem | null => problemOfItems(itemsOfRow(items, kind, namespace, name));

/** One object's attention items as its problem: the worst one's tone and words, and how many. */
export function problemOfItems(own: readonly AttentionItem[]): Problem | null {
  const worst = own.find(({ tone }) => tone === "err") ?? own[0];
  if (!worst) return null;
  const said =
    worst.detail?.says === "said"
      ? worst.detail.text
      : worst.detail?.says === "probe"
        ? worst.detail.failure.said
        : null;
  return {
    tone: worst.tone,
    n: own.length,
    title: said ? `${worst.reason}: ${said}` : worst.reason,
    ...(own.every((item) => item.stale) && {
      stale: {
        at: worst.lastKnown?.at ?? null,
        refused: worst.lastKnown?.refused ?? false,
      },
    }),
  };
}

/**
 * The items the shell carries on this object, by its list's own rule, while
 * `wanted`: its pods' rows and what opens it from elsewhere, for any kind
 * that owns pods, not only those whose list draws the mark. `null` where the
 * shell has not answered.
 */
export function useListedItems(
  kind: string | null | undefined,
  namespace: string | null,
  name: string,
  wanted: boolean
): AttentionItem[] | null {
  const on = wanted && !!kind;
  const attention = useAttention({ enabled: on });
  return useMemo(
    () =>
      on && attention && kind
        ? itemsOfRow(attention.items, kind, namespace, name)
        : null,
    [on, attention, kind, namespace, name]
  );
}

/**
 * The list row's problem for an object whose own findings name none: the
 * same fact the row beside it draws, so a chip whose own read failed or
 * found less does not say all is well where the list says otherwise.
 */
export function useListedProblem(
  kind: string | null | undefined,
  namespace: string | null,
  name: string,
  wanted: boolean
): Problem | null {
  const items = useListedItems(kind, namespace, name, wanted);
  return useMemo(() => items && problemOfItems(items), [items]);
}
