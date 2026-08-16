import { ScrollText } from "lucide-react";

import { commands } from "@/lib/commands";
import { explain, unreachable } from "../reachability";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  defineVendor,
  USAGE_RANGES,
  type ConnectionDraft,
  type ProbeResult,
  type SavedConnection,
} from "../registry";
import { logHistory, PAGE_LINES } from "./client";

/**
 * Loki.
 *
 * Tier three: **configured, never detected**, for the same reason Prometheus
 * is — it may be a single binary in `monitoring`, a microservices install
 * behind a gateway, Grafana Cloud, or a read path in front of something else
 * entirely, and sniffing for a Service called `loki` would be wrong often
 * enough to be worse than asking.
 *
 * No page. Every line Loki has belongs to the pod or the workload it came
 * from, and a Loki screen would be somewhere to go and read the same log with
 * less context around it.
 *
 * What it gives, and what that owes when it is gone:
 *
 * - `logs.history` — a pod that no longer exists, or a container that never
 *   started, gets a past; and a workload's Logs tab can read a range that
 *   includes pods the API server has forgotten. Absent, the viewer is exactly
 *   what it is today: the live stream, `--previous` where the kubelet still
 *   holds a run, and an honest sentence where there is nothing left to read.
 *
 * This is the bigger of the two holes the tier-3 plan named. A Prometheus
 * absent costs the reader some history on a chart that still draws. A Loki
 * absent costs them the log of the container that just crashed — the one
 * thing they came to the app for — and there is no fallback for it anywhere,
 * because the lines are genuinely gone.
 */
export default defineVendor({
  id: "loki",
  name: "Loki",
  extension: {
    gives: "logs from before the current pod existed",
    icon: ScrollText,
  },
  connect: {
    // See the Prometheus record: the old `http://loki.monitoring:3100` is a
    // cluster-internal name and this request is made from your machine.
    urlPlaceholder: "https://loki.example.com",
    // A Loki chart puts up five or six Services and only some of them can
    // answer a query. The gateway is the front door in the distributed
    // chart, the read path is the next best, and a single-binary install has
    // just `loki`. The write path, the ingester and the compactor all answer
    // HTTP and would give a connection that establishes and returns nothing.
    inCluster: {
      names: ["loki"],
      ports: [3100, 80],
      prefer: ["gateway", "query-frontend", "read"],
      avoid: [
        "write",
        "ingester",
        "distributor",
        "compactor",
        "index-gateway",
        "ruler",
        "memberlist",
        "canary",
      ],
    },
    read: () => commands.getLokiConnection().then(asSaved),
    save: (draft: ConnectionDraft) =>
      commands.saveLokiConnection(
        draft.url,
        draft.authType,
        draft.token,
        draft.insecureTls
      ),
    forget: () => commands.forgetLokiConnection(),
    probe: async (draft?: ConnectionDraft): Promise<ProbeResult> => {
      try {
        const answer = await commands.probeLoki(
          draft?.url ?? null,
          draft?.authType ?? null,
          draft?.token ?? null,
          draft?.insecureTls ?? null
        );
        if (!answer.ok) {
          const said = answer.reason ?? "it did not say why";
          // The transport's own words stay — somebody searching for
          // "Name or service not known" has to find it — and the shape of
          // the address adds the half it cannot know. See `../reachability`.
          const shape = unreachable(draft?.url ?? "", said);
          return {
            ok: false,
            at: answer.at,
            reason: shape ? `${said} — ${explain(shape)}` : said,
          };
        }
        return {
          ok: true,
          at: answer.at,
          latencyMs: answer.latencyMs,
          version: answer.version ?? null,
          // Carried through the probe rather than fetched again by the row:
          // the probe already asked, and a second round trip to print one
          // word would double the traffic this integration costs at rest.
          retention: answer.retention ?? null,
        };
      } catch (error) {
        return {
          ok: false,
          at: Date.now(),
          reason: normalizeTauriError(error),
        };
      }
    },
    facts: (saved: SavedConnection, probe: ProbeResult) => {
      if (!probe.ok) {
        return [
          { text: hostOf(saved.url) },
          { text: `did not answer — ${probe.reason}`, tone: "err" as const },
        ];
      }
      return [
        { text: hostOf(saved.url) },
        { text: `answered ${agoOf(probe.at)}` },
        // Only where Loki itself stated it. A guessed retention is the worst
        // fact this screen could carry: a reader told "3 days" who finds
        // nothing from yesterday blames the app, and a reader told nothing
        // goes and looks at their own config.
        ...(probe.retention ? [{ text: `keeps ${probe.retention}` }] : []),
        { text: `ranges ${USAGE_RANGES.join(" · ")}` },
        // The ceiling, named here rather than only discovered when a busy
        // range hits it.
        { text: `up to ${PAGE_LINES.toLocaleString()} lines a page` },
      ];
    },
  },
  // A page for the question a probe cannot answer: an address that speaks
  // LogQL says nothing about *whose* logs are behind it, and a Loki holding
  // another cluster's namespaces answers the history offer with an empty
  // page — which reads as "the lines are gone".
  page: {
    load: () => import("./page"),
  },
  provides: {
    "logs.history": logHistory,
  },
});

function asSaved(
  connection: Awaited<ReturnType<typeof commands.getLokiConnection>>
): SavedConnection | null {
  if (!connection) return null;
  return {
    url: connection.url,
    authType: connection.authType === "bearer" ? "bearer" : "none",
    hasToken: connection.hasToken,
    insecureTls: connection.insecureTls,
  };
}

/** The address without its scheme — the row is narrow and `http://` is noise. */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** "2s ago". Short, because the row is re-read whenever the pane is opened. */
function agoOf(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}
