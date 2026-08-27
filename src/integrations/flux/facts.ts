/**
 * What Flux is doing for this cluster right now.
 *
 * The same reads the page makes, so the row names the two states a list of
 * Kustomizations cannot: a reconciler that is suspended — `Ready` from its
 * last run, reconciling nothing — and one frozen behind a source that stopped
 * fetching, which reports `Ready` as well. A count is inventory and stays
 * quiet; those two are why anybody would open the page.
 */

import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { fetchPicture } from "./data";

export async function facts(): Promise<VendorFact[]> {
  const { reconcilers, sources } = await fetchPicture();

  const lines: VendorFact[] = [
    { say: { key: "factReconcilers", values: { n: reconcilers.length } } },
  ];

  const failing = reconcilers.filter(
    (reconciler) => reconciler.worst === "err"
  ).length;
  if (failing > 0) {
    lines.push({
      say: { key: "factNotReconciled", values: { n: failing } },
      tone: "err",
    });
  }

  const suspended = reconcilers.filter(
    (reconciler) => reconciler.suspended
  ).length;
  if (suspended > 0) {
    lines.push({
      say: { key: "factSuspendedCount", values: { n: suspended } },
      tone: "warn",
    });
  }

  const stopped = sources.filter((source) => source.ready === false).length;
  if (stopped > 0) {
    lines.push({
      say: { key: "factSourceNotFetching", values: { n: stopped } },
      tone: "err",
    });
  }

  if (reconcilers.length > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("flux"),
    });
  }

  return lines;
}
