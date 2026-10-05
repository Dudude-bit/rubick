/**
 * The Pods list narrowed by `?selector=` and `?in=`, the address a policy's
 * pod count links to.
 */

import type { AppSearch } from "@/lib/app-search";
import {
  labelSelectorMatches,
  selectorFromQuery,
  type LabelSelector,
  type Labels,
} from "@/lib/label-selector";

export interface PodFilter {
  text: string;
  /** `null` where the text is not a selector this app can read. */
  selector: LabelSelector | null;
  /** `null` is every namespace. */
  namespaces: string[] | null;
}

/** `?in=` alone is every pod there: the empty selector the URL cannot hold. */
export function podFilterOf(search: AppSearch): PodFilter | null {
  if (search.selector === undefined && search.in === undefined) return null;
  const text = search.selector ?? "";
  const namespaces = search.in
    ? search.in.split(",").filter((name) => name !== "")
    : null;
  return {
    text,
    selector: selectorFromQuery(text),
    namespaces: namespaces && namespaces.length > 0 ? namespaces : null,
  };
}

/**
 * The rows the filter keeps. A selector that cannot be evaluated keeps
 * none: showing every pod under it would claim they all match.
 */
export function narrowPods<P extends { namespace: string; labels: Labels }>(
  rows: P[],
  filter: PodFilter | null
): P[] {
  if (!filter) return rows;
  const { selector, namespaces } = filter;
  if (!selector) return [];
  return rows.filter(
    (pod) =>
      (!namespaces || namespaces.includes(pod.namespace)) &&
      labelSelectorMatches(selector, pod.labels) === true
  );
}

/** The filter's namespaces the window is not looking at. */
export function outsideScope(
  filter: PodFilter,
  scope: readonly string[]
): string[] {
  if (scope.length === 0) return [];
  if (!filter.namespaces) return ["*"];
  return filter.namespaces.filter((name) => !scope.includes(name));
}
