import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";

/** The running build's name and version, asked once per launch. */
export function useAppInfo() {
  return useQuery({
    queryKey: queryKeys.appInfo(),
    queryFn: () => commands.getAppInfo(),
    staleTime: Infinity,
  });
}
