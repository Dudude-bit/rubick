import { useMemo } from "react";

import { useAttention } from "@/hooks/useAttention";
import type { AttentionItem } from "@/lib/attention";
import type { Finding } from "@/lib/governance";
import { ResourceType } from "@/lib/resource-registry";

export type ProblemTone = "err" | "warn";

/** What an object is in trouble for, past what its own status word says. */
export interface Problem {
  tone: ProblemTone;
  n: number;
  /** The worst one's sentence, for a hover. */
  title: string;
}

/** The room a row's "✕ 2 problems ·" mark takes beside its status word. */
export const PROBLEM_MARK_PX = Math.ceil(13 * 6.6);

/** The mark in a cell narrower than `PROBLEM_MARK_ROOM`: glyph, count and dot. */
export const PROBLEM_MARK_COMPACT_PX = 36;

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

/** The worst of the shell's problems one object answers for through another, as its list row counts them. */
export function attentionProblem(
  items: readonly AttentionItem[],
  kind: string,
  namespace: string | null,
  name: string
): Problem | null {
  const own = items.filter(
    ({ kind: of, opens }) =>
      of !== opens.kind &&
      opens.kind === kind &&
      opens.name === name &&
      (opens.namespace ?? "") === (namespace ?? "")
  );
  return problemOfItems(own);
}

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
  };
}

/**
 * The list row's problem for an object whose own findings name none: the
 * same fact the row beside it draws, so a chip whose governing read failed
 * does not say all is well where the list says otherwise.
 */
export function useListedProblem(
  kind: string | null | undefined,
  namespace: string | null,
  name: string,
  wanted: boolean
): Problem | null {
  const on = wanted && !!kind && GOVERNED.has(kind);
  const attention = useAttention({ enabled: on });
  return useMemo(
    () =>
      on && attention && kind
        ? attentionProblem(attention.items, kind, namespace, name)
        : null,
    [on, attention, kind, namespace, name]
  );
}
