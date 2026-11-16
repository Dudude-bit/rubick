import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { isRefusal } from "@/lib/error-utils";
import { forgetRefusals } from "@/lib/refusals";
import { cn } from "@/lib/utils";

const ASKING_AT_MOST_MS = 20_000;

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
  onRetry: () => unknown;
  className?: string;
}) {
  const t = useT();
  // Busy until the answer replaces the error it was pressed on: a refetch's
  // promise can settle before the read lands, and a second press asks twice.
  const [asked, setAsked] = useState<{ about: unknown } | null>(null);
  const asking = asked !== null && asked.about === error;
  useEffect(() => {
    if (!asking) return;
    const id = setTimeout(() => setAsked(null), ASKING_AT_MOST_MS);
    return () => clearTimeout(id);
  }, [asking]);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={asking}
      aria-busy={asking || undefined}
      onClick={() => {
        if (isRefusal(error)) forgetRefusals();
        setAsked({ about: error });
        void commands
          .forgetDiscovery()
          .catch(() => undefined)
          .then(onRetry)
          .catch(() => setAsked(null));
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
