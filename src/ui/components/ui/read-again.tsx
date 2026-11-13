import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { isRefusal } from "@/lib/error-utils";
import { forgetRefusals } from "@/lib/refusals";
import { cn } from "@/lib/utils";

/**
 * Asks a read that did not answer once more. A refused read is offered it
 * too, since rights change; the kept refusal is dropped first, or the
 * answer would come from the cache that holds it. So is what discovery
 * said, which keeps a kind installed a moment ago "not served".
 */
export function ReadAgain({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  /** A promise it returns, such as a refetch, keeps the button turning until it settles. */
  onRetry: () => unknown;
  className?: string;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={asking}
      aria-busy={asking || undefined}
      onClick={() => {
        if (isRefusal(error)) forgetRefusals();
        setAsking(true);
        void commands
          .forgetDiscovery()
          .catch(() => undefined)
          .then(onRetry)
          .catch(() => undefined)
          .finally(() => setAsking(false));
      }}
      // Russian runs longer than English: the label wraps inside the button.
      className={cn(
        "h-auto min-h-6 items-start whitespace-normal py-0.5 text-left",
        className
      )}
    >
      <RefreshCw
        className={cn(
          "mr-1.5 mt-0.5 h-3 w-3 flex-none",
          asking && "animate-spin"
        )}
        aria-hidden="true"
      />
      {t("empty", "unknownRetry")}
    </Button>
  );
}
