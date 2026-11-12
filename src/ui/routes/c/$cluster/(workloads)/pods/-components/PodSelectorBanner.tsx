import { Filter, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSetSearch } from "@/hooks/useSearchParam";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { outsideScope, type PodFilter } from "@/lib/pod-filter";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * What the `?selector=` narrowing is, above the Pods list, with the way
 * out of it. Namespaces the window is not looking at were not read, and the
 * banner says so rather than letting the list read as "no pods match".
 */
export function PodSelectorBanner({ filter }: { filter: PodFilter }) {
  const t = useT();
  const setSearch = useSetSearch();
  const scope = useNamespaceScope();
  const setNamespaceScope = useClusterStore((s) => s.setNamespaceScope);
  const outside = outsideScope(filter, scope.scope);
  const where = filter.namespaces
    ? filter.namespaces.join(", ")
    : t("readings", "podFilterEveryNamespace");

  return (
    <div className="flex flex-col gap-1 border-l-2 border-info py-1 pl-2.5 text-xs">
      <div className="flex items-center gap-2">
        <Filter aria-hidden className="size-3 flex-none text-info" />
        <span className="min-w-0 flex-1 text-fg-mid">
          {parts(
            t("readings", filter.text ? "podFilterMatching" : "podFilterEvery"),
            {
              selector: (
                <span className="font-mono text-fg">{filter.text}</span>
              ),
              namespaces: <span className="font-mono text-fg">{where}</span>,
            }
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 text-[11px]"
          onClick={() => setSearch({ selector: undefined, in: undefined })}
        >
          <X aria-hidden className="size-3" />
          {t("readings", "podFilterClear")}
        </Button>
      </div>
      {!filter.selector && (
        <p className="text-err">
          {t("readings", "podFilterUnreadable", { selector: filter.text })}
        </p>
      )}
      {outside.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 text-warn">
          {filter.namespaces
            ? t("readings", "podFilterOutside", {
                namespaces: outside.join(", "),
              })
            : t("readings", "podFilterOutsideAll")}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => void setNamespaceScope(filter.namespaces ?? [])}
          >
            {t("readings", "podFilterLookThere")}
          </Button>
        </p>
      )}
    </div>
  );
}
