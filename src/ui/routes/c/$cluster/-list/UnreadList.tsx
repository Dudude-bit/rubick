import type { ReactNode } from "react";
import { Lock } from "lucide-react";

import { errorToShow, isRefusal } from "@/lib/error-utils";

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
