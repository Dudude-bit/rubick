import type { Finding } from "@/lib/governance";

export type ProblemTone = "err" | "warn";

/** What an object is in trouble for, past what its own status word says. */
export interface Problem {
  tone: ProblemTone;
  n: number;
  /** The worst one's sentence, for a hover. */
  title: string;
}

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
