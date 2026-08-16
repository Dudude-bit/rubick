/**
 * Whether the Loki somebody connected holds this cluster's logs.
 *
 * The same question Prometheus's page asks, and it matters more here, because
 * the failure is quieter. A log viewer offered history and answering nothing
 * is indistinguishable from a pod that wrote nothing — and the offer only
 * appears where the reader has *just been told there is nothing to read*, so
 * an empty answer confirms exactly the belief it was meant to correct.
 *
 * The comparison is on namespaces. Loki's label set is the app's own
 * (`namespace`, `pod`), and a namespace is the coarsest thing every stream
 * carries; a pod name is gone from the cluster long before it is gone from
 * Loki, so it would prove nothing either way.
 *
 * ## What is asked, and what is not
 *
 * There is one Loki command — a range query — so the check is a query per
 * namespace rather than a call to `/labels`. That would be a request per
 * namespace on a hundred-namespace cluster, so the read is bounded: the
 * namespaces the reader is actually scoped to, and never the whole cluster.
 * A page that cost a hundred queries to say "yes" would not be worth opening.
 */

import { commands } from "@/lib/commands";
import { escapeLabel } from "./queries";

/** How far back to look for any line at all. */
const WINDOW_MS = 60 * 60_000;

/** One line is proof; more would only cost more. */
const LIMIT = 1;

export interface NamespaceCoverage {
  namespace: string;
  /** Whether Loki holds any line at all for it in the window. */
  holds: boolean;
  /** Set where the query itself failed, which is not the same as empty. */
  problem: string | null;
}

export interface Coverage {
  namespaces: NamespaceCoverage[];
  /** How far back the check looked, for the sentence on the page. */
  windowMs: number;
}

export async function coverage(namespaces: string[]): Promise<Coverage> {
  const end = Date.now();
  const start = end - WINDOW_MS;

  const namespacesRead = await Promise.all(
    namespaces.map(async (namespace): Promise<NamespaceCoverage> => {
      try {
        const page = await commands.lokiQueryRange(
          `{namespace="${escapeLabel(namespace)}"}`,
          start,
          end,
          LIMIT,
          null
        );
        return { namespace, holds: page.lines.length > 0, problem: null };
      } catch (error) {
        // A refused query and an empty one are different answers, and only
        // one of them means this Loki does not have the logs.
        return {
          namespace,
          holds: false,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  return { namespaces: namespacesRead, windowMs: WINDOW_MS };
}

export function verdict(found: Coverage): {
  text: string;
  tone: "ok" | "warn" | "err";
} {
  const asked = found.namespaces.filter((entry) => entry.problem === null);
  if (asked.length === 0) return { text: "could not tell", tone: "warn" };
  const holding = asked.filter((entry) => entry.holds).length;
  if (holding === 0) return { text: "holds none of it", tone: "err" };
  if (holding < asked.length) return { text: "holds part of it", tone: "warn" };
  return { text: "holding this cluster", tone: "ok" };
}
