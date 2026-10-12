import { RotateCcw } from "lucide-react";

import type { PodCause } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { causeWords, type CauseWords } from "@/lib/pod-cause";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";

/** The mark a cause leads with, by what it is. */
function CauseMark({
  cause,
  className,
}: {
  cause: PodCause;
  className: string;
}) {
  switch (cause.says) {
    case "exits":
      return <RotateCcw className={className} aria-hidden="true" />;
  }
}

/** The evidence after a cause's sentence: the words quoted, and what was not read. */
export function CauseEvidence({
  words,
  inline = false,
}: {
  words: CauseWords;
  inline?: boolean;
}) {
  const Line = inline ? "span" : "p";
  return (
    <>
      {words.quote && (
        <Line className={inline ? undefined : "mt-0.5 min-w-0"}>
          {inline && " "}
          <span className="text-fg-mut">{words.quote.label}</span>{" "}
          <span className="font-mono wrap-break-word text-fg">
            {words.quote.text}
          </span>
        </Line>
      )}
      {words.note && (
        <Line className={cn("text-fg-fnt", !inline && "mt-0.5")}>
          {inline && " "}
          {words.note}
        </Line>
      )}
    </>
  );
}

/**
 * A pod's cause: the mark and colour of what happened, the sentence, then
 * the evidence. Every surface that leads with a pod's trouble draws it
 * through this, or through {@link causeWords} where it has only a string.
 */
export function CauseLine({
  cause,
  compact = false,
  className,
}: {
  cause: PodCause;
  /** One run of text, for a row that clamps it. */
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const words = causeWords(cause, t);
  const tone = TONE_TEXT[words.tone];
  if (compact)
    return (
      <span className={className} data-testid="cause-line">
        <CauseMark
          cause={cause}
          className={cn("mr-1 inline h-2.5 w-2.5 align-[-1px]", tone)}
        />
        <span className={tone}>{words.sentence}.</span>
        <CauseEvidence words={words} inline />
      </span>
    );
  return (
    <div
      className={cn("flex items-start gap-2 text-xs", className)}
      data-testid="cause-line"
    >
      <CauseMark
        cause={cause}
        className={cn("mt-0.5 h-3 w-3 flex-none", tone)}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium", tone)}>{words.sentence}.</p>
        <CauseEvidence words={words} />
      </div>
    </div>
  );
}
