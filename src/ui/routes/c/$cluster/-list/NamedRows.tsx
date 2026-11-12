import { ListFilter, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSetSearch } from "@/hooks/useSearchParam";
import { useT } from "@/i18n/useT";

/**
 * Above a list narrowed to the rows a link named: how many, how many are not
 * here now, and the way back to all of them. A named row is gone only from a
 * list that was read whole: from a refused, cut or half-read one it is merely
 * not among what was read.
 */
export function NamedRowsBanner({
  named,
  found,
  whole,
}: {
  named: ReadonlySet<string>;
  /** The named rows in the list as read, before any other filter. */
  found: number;
  /** The list was read whole, so a row not found is not in it. */
  whole: boolean;
}) {
  const t = useT();
  const setSearch = useSetSearch();
  const missing = named.size - found;
  return (
    <div className="flex flex-col gap-1 border-l-2 border-info py-1 pl-2.5 text-xs">
      <div className="flex items-center gap-2">
        <ListFilter aria-hidden className="size-3 flex-none text-info" />
        <span className="min-w-0 flex-1 text-fg-mid">
          {t("readings", "namedRowsOnly", { n: named.size })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 text-[11px]"
          onClick={() => setSearch({ names: undefined })}
        >
          <X aria-hidden className="size-3" />
          {t("readings", "namedRowsShowAll")}
        </Button>
      </div>
      {missing > 0 &&
        (whole ? (
          <p className="text-warn">
            {t("readings", "namedRowsMissing", { n: missing })}
          </p>
        ) : (
          <p className="text-fg-mut">
            {t("readings", "namedRowsUnread", { n: missing })}
          </p>
        ))}
    </div>
  );
}
