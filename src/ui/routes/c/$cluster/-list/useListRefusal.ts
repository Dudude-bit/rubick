import type { ListQuery } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { isRefusal } from "@/lib/error-utils";
import { refusedEverywhereAsked, useListableIn } from "../-shell/useListAccess";

export interface ListRefusal {
  /** Refused across the whole cluster, where one namespace may still answer. */
  acrossCluster: boolean;
  /** Refused in every namespace the app could name too: no way out to offer. */
  nowhere: boolean;
  listableIn: readonly string[];
  /** The sentence for a refused read. */
  words: string;
}

/**
 * How a refused list is said, and where it may be listed instead. `narrows`
 * is whether the window reads every namespace and one namespace narrows this
 * kind; `query` asks the authorizer where it may be listed.
 */
export function useListRefusal(
  failed: unknown,
  narrows: boolean,
  query: ListQuery | null
): ListRefusal {
  const t = useT();
  const acrossCluster = narrows && failed != null && isRefusal(failed);
  const reach = useListableIn(acrossCluster ? query : null);
  const nowhere = acrossCluster && refusedEverywhereAsked(reach);
  return {
    acrossCluster,
    nowhere,
    listableIn: reach.readableIn,
    words: nowhere
      ? t("empty", "refusedClusterWideAndIn", {
          n: reach.refusedIn.length,
          namespaces: reach.refusedIn.join(", "),
        })
      : acrossCluster
        ? t(
            "empty",
            // The way out under it names the namespace; saying one may answer
            // as well said it twice.
            reach.readableIn.length > 0
              ? "refusedClusterWideOnly"
              : "refusedClusterWide"
          )
        : t("nav", "noListAccess"),
  };
}
