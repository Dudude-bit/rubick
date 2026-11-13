import { TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { ProblemSummary } from "@/components/object/detail-blocks";
import { useT } from "@/i18n/useT";
import type { Finding } from "@/lib/governance";
import type { StatusRole } from "@/lib/status-role";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { FindingEvidence, FindingLine } from "./FindingLine";
import type { Problem, ProblemTone } from "./problem";

const RECOLOUR: Record<ProblemTone, string> = {
  err: "[&_*]:text-err!",
  warn: "[&_*]:text-warn!",
};

const TONE_GLYPH = { err: X, warn: TriangleAlert } as const;

/**
 * A status chip that carries the object's worst problem: the word is drawn in
 * the problem's tone and followed by how many there are, so a green "Ready"
 * is never printed above an amber cause. A badge already louder than the
 * problem is left as it is.
 */
export function WithProblem({
  problem,
  role,
  children,
}: {
  problem: Problem | null;
  /** The role the wrapped badge is drawn in. */
  role: StatusRole;
  children: ReactNode;
}) {
  const t = useT();
  if (!problem) return <>{children}</>;
  const quiet = role !== "warn" && role !== "err";
  const Glyph = TONE_GLYPH[problem.tone];
  return (
    <span
      className="inline-flex min-w-0 items-baseline gap-1.5"
      title={problem.title}
      data-problem={problem.tone}
    >
      <span
        className={cn("inline-flex min-w-0", quiet && RECOLOUR[problem.tone])}
      >
        {children}
      </span>
      <span
        className={cn(
          "inline-flex flex-none items-center gap-1 text-caption font-medium",
          TONE_TEXT[problem.tone]
        )}
      >
        <span aria-hidden="true">·</span>
        <Glyph className="h-2.5 w-2.5" aria-hidden="true" />
        {t("cluster", "problemCount", { n: problem.n })}
      </span>
    </span>
  );
}

/** The findings an object earned, directly under its header: trouble as a headline in its tone, the rest as a line. */
export function FindingsBlock({ findings }: { findings: readonly Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="findings-block">
      {findings.map((finding) =>
        finding.tone === "neutral" ? (
          <FindingLine key={finding.title} finding={finding} />
        ) : (
          <ProblemSummary
            key={finding.title}
            tone={finding.tone}
            headline={finding.title}
            detail={
              <>
                {finding.detail} <FindingEvidence finding={finding} />
              </>
            }
          />
        )
      )}
    </div>
  );
}
