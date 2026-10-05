import { useMemo } from "react";

import { useAppSearch } from "@/hooks/useSearchParam";
import { podFilterOf, type PodFilter } from "@/lib/pod-filter";

/** The Pods list's `?selector=` narrowing, stable while the address is. */
export function usePodFilter(): PodFilter | null {
  const { selector, in: namespaces } = useAppSearch();
  return useMemo(
    () => podFilterOf({ selector, in: namespaces }),
    [selector, namespaces]
  );
}
