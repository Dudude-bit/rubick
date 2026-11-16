import { cn } from "@/lib/utils";
import { LIST_NOTICE_WIDTH } from "./list-unread";
import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Reading } from "@/components/ui/states";
import { useNamespaceList } from "@/hooks/useClusterSummary";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { useT } from "@/i18n/useT";
import { Unknown } from "@/components/ui/unknown";
import { openNamespacePicker } from "@/lib/read-deadline";
import type { ListRefusal } from "./useListRefusal";

export function AskedAgain({ since }: { since: number }) {
  const t = useT();
  const age = useRealtimeAge(new Date(since).toISOString());
  return (
    <Reading className="mt-2">
      {t("empty", "refusedAskingAgain", {
        age: t("action", "agoSuffix", { age }),
      })}
    </Reading>
  );
}

/** A list that has no rows because nobody could read it, in place of its table. */
export function UnreadList({
  error,
  words,
  onRetry,
  askedAgainAfter = null,
  children,
}: {
  error: unknown;
  words: string;
  /** Ask again; a refusal too, since rights change. */
  onRetry?: () => unknown;
  /** When the refusal on screen was said, while the cluster is asked again. */
  askedAgainAfter?: number | null;
  children?: ReactNode;
}) {
  return (
    <div className={cn(LIST_NOTICE_WIDTH, "pb-8")} data-testid="unread-list">
      <Unknown question={words} error={error} onRetry={onRetry} />
      {askedAgainAfter !== null && <AskedAgain since={askedAgainAfter} />}
      {children}
    </div>
  );
}

/** The namespaces a list refused across the cluster reads in, and the picker that goes there. */
export function RefusalWayOut({ refusal }: { refusal: ListRefusal }) {
  const t = useT();
  const checked = useNamespaceList().state === "listed";
  if (!refusal.acrossCluster || refusal.nowhere) return null;
  const { listableIn } = refusal;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {listableIn.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-info">
          <FolderOpen className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          {t(
            "empty",
            checked ? "listableInNamespaces" : "listableInUnchecked",
            {
              n: listableIn.length,
              namespaces: listableIn.join(", "),
            }
          )}
        </p>
      )}
      <Button size="sm" variant="outline" onClick={openNamespacePicker}>
        {t("action", "chooseNamespace")}
      </Button>
    </div>
  );
}
