import type { T } from "@/i18n/useT";
import type { RouteMatchInfo } from "@/generated/types";

/**
 * One match, in the kind's own vocabulary.
 *
 * Shared between the route detail page's Rules tab and its Share
 * contribution, so a match reads the same words in both places.
 */
export function sayMatch(match: RouteMatchInfo, t: T): string {
  const parts: string[] = [];
  if (match.path) {
    parts.push(
      match.pathType === "Exact" ? `= ${match.path}` : `${match.path}…`
    );
  }
  if (match.method) parts.push(match.method);
  if (match.grpcService || match.grpcMethod) {
    parts.push([match.grpcService ?? "*", match.grpcMethod ?? "*"].join("/"));
  }
  parts.push(...match.headers);
  parts.push(...match.queryParams.map((param) => `?${param}`));
  return parts.length > 0
    ? parts.join(" · ")
    : t("empty", "matchesEverythingWord");
}
