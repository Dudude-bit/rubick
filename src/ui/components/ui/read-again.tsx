import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { isRefusal } from "@/lib/error-utils";
import { forgetRefusals } from "@/lib/refusals";
import { cn } from "@/lib/utils";

/**
 * Asks a read that did not answer once more. A refused read is offered it
 * too, since rights change; the kept refusal is dropped first, or the
 * answer would come from the cache that holds it.
 */
export function ReadAgain({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        if (isRefusal(error)) forgetRefusals();
        onRetry();
      }}
      // Russian runs longer than English: the label wraps inside the button.
      className={cn(
        "h-auto min-h-6 items-start whitespace-normal py-0.5 text-left",
        className
      )}
    >
      <RefreshCw
        className="mr-1.5 mt-0.5 h-3 w-3 flex-none"
        aria-hidden="true"
      />
      {t("empty", "unknownRetry")}
    </Button>
  );
}
