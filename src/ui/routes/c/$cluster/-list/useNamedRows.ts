import { useMemo } from "react";

import { useAppSearchValue } from "@/hooks/useSearchParam";

/** The `?names=` a list is narrowed to, as row identities, or `null` for every row. */
export function useNamedRows(): ReadonlySet<string> | null {
  const names = useAppSearchValue("names");
  return useMemo(
    () => (names ? new Set(names.split(",").filter(Boolean)) : null),
    [names]
  );
}
