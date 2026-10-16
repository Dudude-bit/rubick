import type { Finding } from "@/lib/governance";
import { cn } from "@/lib/utils";

const FINDING_TONE: Record<Finding["tone"], string> = {
  err: "text-err",
  warn: "text-warn",
  // The honest one. `disruptionsAllowed: 0` on a budget that is exactly met
  // is a fact the reader wants and is not a fault, so it reads in the same
  // foreground every other stated fact on the page reads in.
  neutral: "text-fg-mut",
};

/** A state worth a sentence, under the rows that could not carry it. */
export function FindingLine({ finding }: { finding: Finding }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1.5">
      <p className={cn("text-xs font-medium", FINDING_TONE[finding.tone])}>
        {finding.title}
      </p>
      <p className="text-[11px] text-fg-fnt">{finding.detail}</p>
    </div>
  );
}
