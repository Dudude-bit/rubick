import { TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { ProblemSummary } from "@/components/object/detail-blocks";
import { useT, type T } from "@/i18n/useT";
import type { Finding } from "@/lib/governance";
import type { StatusRole } from "@/lib/status-role";
import { TONE_TEXT } from "@/lib/tone";
import { cn, formatWhen } from "@/lib/utils";
import { FindingDetail, FindingLine } from "./FindingLine";
import type { Problem } from "./problem";

const TONE_GLYPH = { err: X, warn: TriangleAlert } as const;

/** Where the noun gives way to the count alone: `PROBLEM_MARK_ROOM_PX` and `PROBLEM_STALE_ROOM_PX`, spelled whole for the class scanner. */
const NOUN = {
  fresh: { whole: "@max-[153px]:hidden", count: "hidden @max-[153px]:inline" },
  stale: { whole: "@max-[264px]:hidden", count: "hidden @max-[264px]:inline" },
} as const;

/** Why a kept problem was not checked again, and since when it is the last word, ahead of its own. */
function staleTitle({ title, stale }: Problem, t: T): string {
  if (!stale) return title;
  const why =
    stale.at === null
      ? t("cluster", "problemNotRecheckedUnseenTitle")
      : t(
          "cluster",
          stale.refused
            ? "problemNotRecheckedRefused"
            : "problemNotRecheckedFailed",
          { time: formatWhen(stale.at, "clock") }
        );
  return `${why}\n${title}`;
}

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
  /** The role the wrapped badge is drawn in; null for what is not a status word, such as a name. */
  role: StatusRole | null;
  children?: ReactNode;
}) {
  const t = useT();
  if (!problem) return <>{children}</>;
  const quiet = role !== null && role !== "warn" && role !== "err";
  // A crash loop nobody could look at again is still a crash loop: the mark
  // keeps its severity, and only the amber "not rechecked" says it is old.
  const { tone } = problem;
  const Glyph = TONE_GLYPH[tone];
  const noun = NOUN[problem.stale ? "stale" : "fresh"];
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-baseline gap-1.5"
      title={staleTitle(problem, t)}
      data-problem={tone}
      {...(problem.stale && { "data-problem-stale": "" })}
    >
      <span
        data-problem-mark=""
        className={cn(
          "inline-flex flex-none items-center gap-1 text-caption font-medium",
          TONE_TEXT[tone]
        )}
      >
        <span className="relative inline-flex">
          <Glyph className="h-2.5 w-2.5" aria-hidden="true" />
          {/* Where the words give way, an amber dot still says the count is
           *  old; it sits on the glyph, so the floors need no more room. */}
          {problem.stale && (
            <span
              data-problem-stale-glyph=""
              role="img"
              aria-label={t("cluster", "problemNotRechecked")}
              className={cn(
                "absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-warn ring-1 ring-canvas",
                noun.count
              )}
            />
          )}
        </span>
        {/* In a narrow cell (an `@container`) the count alone; whole on hover. */}
        <span className={noun.whole}>
          {t("cluster", "problemCount", { n: problem.n })}
        </span>
        <span className={noun.count}>{problem.n}</span>
        {problem.stale && (
          <span
            data-problem-not-rechecked=""
            className={cn("inline-flex gap-1 text-warn", noun.whole)}
          >
            <span aria-hidden="true">·</span>
            <span>{t("cluster", "problemNotRechecked")}</span>
          </span>
        )}
        {children != null && <span aria-hidden="true">·</span>}
      </span>
      {children != null && (
        <span
          data-problem-word={quiet ? "quiet" : "loud"}
          className={cn("inline-flex min-w-0", quiet && "[&_*]:text-fg-mut!")}
        >
          {children}
        </span>
      )}
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
