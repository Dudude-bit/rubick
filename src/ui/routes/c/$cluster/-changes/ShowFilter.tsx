import { Lock } from "lucide-react";

import type { Show } from "@/generated/types";
import { refusedFor, type SpanCover } from "@/lib/changes";
import { TOGGLE } from "./toggle";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";

const SHOWS = {
  all: "showAll",
  changes: "showChanges",
  warnings: "showWarnings",
} as const satisfies Record<Show, string>;

/** Everything, changes only, warnings only; a filter the cluster refused a kind of says so on itself. */
export function ShowFilter({
  show,
  onShow,
  watching,
}: {
  show: Show;
  onShow: (show: Show) => void;
  /** The running watch, whose refusals a filter names. */
  watching: SpanCover | undefined;
}) {
  const t = useT();
  return (
    <div
      className="flex items-center gap-0.5"
      role="group"
      aria-label={t("changes", "title")}
    >
      {(Object.keys(SHOWS) as Show[]).map((candidate) => {
        const blind = refusedFor(candidate, watching, t);
        return (
          <button
            key={candidate}
            type="button"
            aria-pressed={show === candidate}
            onClick={() => onShow(candidate)}
            title={blind ?? undefined}
            className={cn(
              TOGGLE,
              show === candidate ? "bg-sel text-fg" : "text-fg-mut"
            )}
          >
            {blind && <Lock className="h-3 w-3 text-warn" aria-label={blind} />}
            {t("changes", SHOWS[candidate])}
          </button>
        );
      })}
    </div>
  );
}
