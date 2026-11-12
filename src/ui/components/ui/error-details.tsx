import { ChevronRight } from "lucide-react";

import { CopyButton } from "@/components/ui/copyable-value";
import { useT } from "@/i18n/useT";
import { useShownPath } from "@/lib/hide-paths";
import { cn } from "@/lib/utils";

/**
 * The machine's own words, folded under a human line: kept whole for the
 * reader who needs them, out of the way of the one who does not.
 */
export function ErrorDetails({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const t = useT();
  const shown = useShownPath()(text);
  return (
    <details className={cn("group text-[11px]", className)}>
      <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-sm text-fg-fnt transition-colors hover:text-fg-mut focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="h-3 w-3 transition-transform group-open:rotate-90"
        />
        {t("action", "details")}
      </summary>
      <div className="mt-1 flex items-start gap-2 rounded-md border border-hair px-2 py-1.5">
        <pre className="max-h-48 min-w-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all font-mono text-fg-mut">
          {shown}
        </pre>
        <CopyButton
          value={shown}
          label={t("action", "copyDetails")}
          className="opacity-100"
        />
      </div>
    </details>
  );
}
