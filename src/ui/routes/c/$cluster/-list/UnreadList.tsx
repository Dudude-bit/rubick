import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { Unknown } from "@/components/ui/unknown";
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
  onRetry?: () => unknown;
  children?: ReactNode;
}) {
  return (
    <div className="max-w-[68ch] pb-8" data-testid="unread-list">
      <Unknown question={words} error={error} onRetry={onRetry} />
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
