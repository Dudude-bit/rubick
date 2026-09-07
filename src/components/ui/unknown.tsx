import type { ReactNode } from "react";
import { ClipboardCopy, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { errorToShow, isRefusal } from "@/lib/error-utils";
import { parseRefusal, rbacRule } from "@/lib/refusal";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

export interface UnknownProps {
  /** What could not be answered, as a question the reader asked. */
  question: ReactNode;
  /** The failure, as the read returned it. */
  error: unknown;
  /** Ask the same read again. Offered whenever the caller can. */
  onRetry?: () => void;
  className?: string;
}

/**
 * A read that did not happen, with a way out.
 *
 * Every "could not look" in the app renders this, so that none of them ends
 * in a sentence: a refusal turns into the rule to ask an administrator for,
 * a fault into a retry. The verdict around it does not move because a
 * button was pressed; only a read that succeeds moves it.
 */
export function Unknown({ question, error, onRetry, className }: UnknownProps) {
  const t = useT();
  const copy = useCopyToClipboard();
  const message = errorToShow(error);
  const refused = isRefusal(error);
  const refusal = parseRefusal(message);

  return (
    <div
      role="status"
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-dashed border-hair px-3 py-2 text-xs",
        className
      )}
    >
      <p className="flex items-start gap-2 text-fg">
        <TriangleAlert
          className="mt-0.5 h-3.5 w-3.5 flex-none text-warn"
          aria-hidden="true"
        />
        <span className="min-w-0">{question}</span>
      </p>
      <p className="pl-[22px] text-fg-mut">
        {refused
          ? t("empty", "unknownRefused", { message })
          : t("empty", "unknownFault", { message })}
      </p>
      <div className="flex flex-wrap gap-1.5 pl-[22px] pt-0.5">
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3 w-3" aria-hidden="true" />
            {t("empty", "unknownRetry")}
          </Button>
        )}
        {refusal && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void copy(rbacRule(refusal), t("empty", "unknownRuleCopied"))
            }
          >
            <ClipboardCopy className="mr-1.5 h-3 w-3" aria-hidden="true" />
            {t("empty", "unknownCopyRule")}
          </Button>
        )}
      </div>
    </div>
  );
}
