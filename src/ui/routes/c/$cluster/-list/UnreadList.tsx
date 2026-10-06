import type { ReactNode } from "react";
import { FolderOpen, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/useT";
import { errorToShow, isRefusal } from "@/lib/error-utils";
import { openNamespacePicker } from "@/lib/read-deadline";
import type { ListRefusal } from "./useListRefusal";

/** A list that has no rows because nobody could read it, in place of its table. */
export function UnreadList({
  error,
  words,
  children,
}: {
  error: Error;
  words: string;
  children?: ReactNode;
}) {
  return (
    <div className="max-w-[68ch] py-8" data-testid="unread-list">
      <p className="flex items-center gap-1.5 text-xs text-err">
        {isRefusal(error) && (
          <Lock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
        )}
        {words}
      </p>
      <p className="mt-1.5 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
        {errorToShow(error)}
      </p>
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
