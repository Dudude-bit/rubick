import { Lock, TriangleAlert } from "lucide-react";

import { useT } from "@/i18n/useT";
import { isRefusal } from "@/lib/error-utils";
import { cn } from "@/lib/utils";
import type { ObjectUnread } from "./object-unread";

/**
 * A part read through an object its own read cannot answer for now: one
 * quiet line, worded from the object's failure as it is now, where a box of
 * its own would repeat the notice above with a cause that may be stale.
 */
export function WaitsOnObject({
  unread,
  className,
}: {
  unread: ObjectUnread;
  className?: string;
}) {
  const t = useT();
  const refused = isRefusal(unread.failure);
  const Glyph = refused ? Lock : TriangleAlert;
  return (
    <p
      data-testid="waits-on-object"
      data-read={refused ? "refused" : "failed"}
      className={cn(
        "flex items-start gap-1.5 text-caption text-fg-mut",
        className
      )}
    >
      <Glyph className="mt-px h-3 w-3 flex-none text-warn" aria-hidden="true" />
      {t("empty", refused ? "waitsOnRefusedObject" : "waitsOnFailedObject", {
        kind: unread.kind,
        name: unread.name,
      })}
    </p>
  );
}
