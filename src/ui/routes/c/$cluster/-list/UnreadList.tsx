import type { ReactNode } from "react";
import { CircleX, FolderOpen, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { ReadAgain } from "@/components/ui/read-again";
import { errorToShow, isRefusal } from "@/lib/error-utils";
import { cn } from "@/lib/utils";
import { openNamespacePicker } from "@/lib/read-deadline";
import type { ListRefusal } from "./useListRefusal";

/** A list that has no rows because nobody could read it, in place of its table. */
export function UnreadList({
  error,
  words,
  onRetry,
  children,
}: {
  error: unknown;
  words: string;
  /** Ask again; a refusal too, since rights change. */
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const refused = isRefusal(error);
  return (
    <div className="max-w-[68ch] pb-8" data-testid="unread-list">
      <p
        data-read={refused ? "refused" : "failed"}
        className={cn(
          "flex items-center gap-1.5 text-xs",
          refused ? "text-warn" : "text-err"
        )}
      >
        {refused ? (
          <Lock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        ) : (
          <CircleX className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        )}
        {words}
      </p>
      <p className="mt-1.5 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
        {errorToShow(error)}
      </p>
      {onRetry && (
        <ReadAgain error={error} onRetry={onRetry} className="mt-2" />
      )}
      {children}
    </div>
  );
}

/** The namespaces a list refused across the cluster reads in, and the picker that goes there. */
export function RefusalWayOut({ refusal }: { refusal: ListRefusal }) {
  const t = useT();
  if (!refusal.acrossCluster || refusal.nowhere) return null;
  const { listableIn } = refusal;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {listableIn.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-info">
          <FolderOpen className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          {t("empty", "listableInNamespaces", {
            n: listableIn.length,
            namespaces: listableIn.join(", "),
          })}
        </p>
      )}
      <Button size="sm" variant="outline" onClick={openNamespacePicker}>
        {t("action", "chooseNamespace")}
      </Button>
    </div>
  );
}
