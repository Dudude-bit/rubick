import { TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { ProblemSummary } from "@/components/object/detail-blocks";
import { useT } from "@/i18n/useT";
import type { Finding } from "@/lib/governance";
import type { StatusRole } from "@/lib/status-role";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { FindingDetail, FindingLine } from "./FindingLine";
import type { Problem } from "./problem";

const TONE_GLYPH = { err: X, warn: TriangleAlert } as const;

/**
 * A status chip that carries the object's worst problem: the mark leads in
 * the problem's tone and never shrinks, so a narrow cell cuts the word and
 * not the mark. A quiet word beside it goes neutral, neither the green that
 * says all is well nor the problem's colour, which would say the status
 * itself is bad. A badge already louder than the problem is left as it is.
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
      className="inline-flex min-w-0 max-w-full items-baseline gap-1.5"
      title={problem.title}
      data-problem={problem.tone}
    >
      <span
        data-problem-mark=""
        className={cn(
          "inline-flex flex-none items-center gap-1 text-caption font-medium",
          TONE_TEXT[problem.tone]
        )}
      >
        <Glyph className="h-2.5 w-2.5" aria-hidden="true" />
        {/* In a narrow cell (an `@container`) the count alone; whole on hover. */}
        <span className="@max-[11rem]:hidden">
          {t("cluster", "problemCount", { n: problem.n })}
        </span>
        <span className="hidden @max-[11rem]:inline">{problem.n}</span>
        <span aria-hidden="true">·</span>
      </span>
      <span
        data-problem-word={quiet ? "quiet" : "loud"}
        className={cn("inline-flex min-w-0", quiet && "[&_*]:text-fg-mut!")}
      >
        {children}
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
            detail={<FindingDetail finding={finding} />}
          />
        )
      )}
    </div>
  );
}
