import type { Finding } from "@/lib/governance";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

const FINDING_TONE: Record<Finding["tone"], string> = {
  err: "text-err",
  warn: "text-warn",
  // The honest one. `disruptionsAllowed: 0` on a budget that is exactly met
  // is a fact the reader wants and is not a fault, so it reads in the same
  // foreground every other stated fact on the page reads in.
  neutral: "text-fg-mut",
};

/** The readings that caused a finding, in its tone, so the number is not a plain word in another column. */
export function FindingEvidence({ finding }: { finding: Finding }) {
  const t = useT();
  if (!finding.evidence?.length) return null;
  return (
    <>
      {finding.evidence.map(({ key, label, current, target }) => (
        <span
          key={key}
          data-testid="finding-evidence"
          className={cn("font-mono font-medium", FINDING_TONE[finding.tone])}
        >
          {t("readings", "hpaMetricOverTarget", {
            metric: label,
            current: current ?? "",
            target,
          })}
        </span>
      ))}
    </>
  );
}

/** A state worth a sentence, under the rows that could not carry it. */
export function FindingLine({ finding }: { finding: Finding }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1.5">
      <p className={cn("text-xs font-medium", FINDING_TONE[finding.tone])}>
        {finding.title}
      </p>
      <p className="text-caption text-fg-fnt">
        {finding.detail} <FindingEvidence finding={finding} />
      </p>
    </div>
  );
}
