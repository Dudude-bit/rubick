import { ListFilter, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSetSearch } from "@/hooks/useSearchParam";
import { useT } from "@/i18n/useT";

/** Above a list narrowed to the rows a link named: how many, how many are not here now, and the way back to all of them. */
export function NamedRowsBanner({
  named,
  found,
}: {
  named: ReadonlySet<string>;
  found: number;
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
      {missing > 0 && (
        <p className="text-warn">
          {t("readings", "namedRowsMissing", { n: missing })}
        </p>
      )}
    </div>
  );
}
