import type { ReactNode } from "react";
import { ClipboardCopy, Lock, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { errorToShow, isRefusal } from "@/lib/error-utils";
import { parseRefusal, rbacRule, type Refusal } from "@/lib/refusal";
import { ReadAgain } from "@/components/ui/read-again";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

export interface UnknownProps {
  /** What could not be answered, as a question the reader asked. */
  question: ReactNode;
  /** The failure, as the read returned it. */
  error: unknown;
  /** Ask the same read again. Offered whenever the caller can. */
  onRetry?: () => unknown;
  /** One line above content still on screen, so the content does not move down. */
  compact?: boolean;
  className?: string;
}

export function CopyRule({ refusal }: { refusal: Refusal }) {
  const t = useT();
  const copy = useCopyToClipboard();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        void copy(rbacRule(refusal), t("empty", "unknownRuleCopied"))
      }
      className="h-auto min-h-6 items-start whitespace-normal py-0.5 text-left"
    >
      <ClipboardCopy
        className="mr-1.5 mt-0.5 h-3 w-3 flex-none"
        aria-hidden="true"
      />
      {t("empty", "unknownCopyRule")}
    </Button>
  );
}

/**
 * A read that did not happen, with a way out.
 *
 * Every "could not look" in the app renders this, so that none of them ends
 * in a sentence: a refusal turns into the rule to ask an administrator for,
 * a fault into a retry. The verdict around it does not move because a
 * button was pressed; only a read that succeeds moves it.
 */
export function Unknown({
  question,
  error,
  onRetry,
  compact = false,
  className,
}: UnknownProps) {
  const t = useT();
  const message = errorToShow(error);
  const refused = isRefusal(error);
  const refusal = parseRefusal(message);
  const Glyph = refused ? Lock : TriangleAlert;
  const said = refused
    ? t("empty", "unknownRefused", { message })
    : t("empty", "unknownFault", { message });

  if (compact)
    return (
      <div
        role="status"
        data-read={refused ? "refused" : "failed"}
        className={cn(
          "flex min-h-7 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border border-dashed border-hair px-2.5 py-0.5 text-xs",
          className
        )}
      >
        <Glyph className="h-3.5 w-3.5 flex-none text-warn" aria-hidden="true" />
        <span className="min-w-0 text-fg">{question}</span>
        <span
          className="min-w-0 flex-1 basis-40 truncate text-fg-mut"
          title={said}
        >
          {said}
        </span>
        {onRetry && (
          <ReadAgain error={error} onRetry={onRetry} className="flex-none" />
        )}
      </div>
    );

  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-dashed border-hair px-3 py-2 text-xs",
        className
      )}
    >
      <p
        className="flex items-start gap-2 text-fg"
        data-read={refused ? "refused" : "failed"}
      >
        <Glyph
          className="mt-0.5 h-3.5 w-3.5 flex-none text-warn"
          aria-hidden="true"
        />
        <span className="min-w-0">{question}</span>
      </p>
      <p className="pl-[22px] text-fg-mut">{said}</p>
      <div className="flex flex-wrap gap-1.5 pl-[22px] pt-0.5">
        {onRetry && <ReadAgain error={error} onRetry={onRetry} />}
        {refusal && <CopyRule refusal={refusal} />}
      </div>
    </div>
  );
}
