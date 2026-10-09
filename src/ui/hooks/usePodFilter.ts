import { useMemo } from "react";

import { useAppSearchValue } from "@/hooks/useSearchParam";
import { podFilterOf, type PodFilter } from "@/lib/pod-filter";

/** The Pods list's `?selector=` narrowing, stable while the address is. */
export function usePodFilter(): PodFilter | null {
  const selector = useAppSearchValue("selector");
  const namespaces = useAppSearchValue("in");
  return useMemo(
    () => podFilterOf({ selector, in: namespaces }),
    [selector, namespaces]
  );
}
