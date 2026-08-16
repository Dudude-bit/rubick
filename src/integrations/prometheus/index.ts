import { Flame } from "lucide-react";

import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  defineVendor,
  USAGE_RANGES,
  type ConnectionDraft,
  type ProbeResult,
  type SavedConnection,
} from "../registry";
import { networkTraffic, usageHistory, volumeFullness } from "./client";
import { RANGE_SPECS } from "./queries";

/**
 * Prometheus.
 *
 * Tier three: **configured, never detected.** There is no reliable way to
 * find one — it may be kube-prometheus-stack in `monitoring`, a bare
 * Deployment somewhere, Thanos, Mimir, or a SaaS endpoint outside the
 * cluster entirely. Sniffing for a namespace called `monitoring` or a
 * Service called `prometheus` would be the same guessing this app refuses
 * everywhere else, and would be wrong often enough to be worse than asking.
 * So it is a URL the reader gives us, per cluster, in Settings.
 *
 * No page, and that is the rule from `registry.ts` rather than an omission:
 * a vendor earns a page when it owns a topology no core object can host.
 * Every fact Prometheus has belongs on the pod, the workload or the node it
 * is about, and a Prometheus screen would be somewhere to go and find the
 * same numbers with less context around them.
 *
 * What it gives, and what each one owes when it is gone:
 *
 * - `usage.history` — the ranges come alive. Absent, the chart draws the
 *   window the app watched itself, exactly as it does today.
 * - `volume.fullness` — the storage row gains used and capacity. Absent, it
 *   keeps the sentence about declared size that it already says.
 * - `network.traffic` — a third band. Absent, the band is not drawn, because
 *   there is no core answer to fall back to and a placeholder would be a
 *   nag repeated on every page.
 */
export default defineVendor({
  id: "prometheus",
  name: "Prometheus",
  extension: {
    gives: "usage history, volume fullness and traffic on pods and workloads",
    icon: Flame,
  },
  connect: {
    urlPlaceholder: "http://prometheus.monitoring:9090",
    read: () => commands.getPrometheusConnection().then(asSaved),
    save: (draft: ConnectionDraft) =>
      commands.savePrometheusConnection(
        draft.url,
        draft.authType,
        draft.token,
        draft.insecureTls
      ),
    forget: () => commands.forgetPrometheusConnection(),
    probe: async (draft?: ConnectionDraft): Promise<ProbeResult> => {
      try {
        const answer = await commands.probePrometheus(
          draft?.url ?? null,
          draft?.authType ?? null,
          draft?.token ?? null,
          draft?.insecureTls ?? null
        );
        if (!answer.ok) {
          return {
            ok: false,
            at: answer.at,
            reason: answer.reason ?? "it did not say why",
          };
        }
        return {
          ok: true,
          at: answer.at,
          latencyMs: answer.latencyMs,
          version: answer.version ?? null,
        };
      } catch (error) {
        // A command that threw is still a failed probe, not a crash: the row
        // has somewhere to print this and the surfaces have a fallback.
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
        // What the address buys, named rather than implied — the row's whole
        // job is to say what you get for having plumbed it.
        { text: `ranges ${USAGE_RANGES.join(" · ")}` },
        // One range's resolution spelled out, so "what does a bucket hide"
        // is answerable from this row rather than only from a chart caption.
        { text: `1h in ${RANGE_SPECS["1h"].resolution}` },
      ];
    },
  },
  // A page, and it took a while to earn one. Prometheus supplies powers
  // rather than objects, and a page repeating its numbers would be a worse
  // copy of the chart the reader already has. What it owns is a question
  // about the connection: a probe proves the address speaks PromQL, and
  // cannot tell you the Prometheus you reached is scraping *this* cluster.
  page: {
    load: () => import("./page"),
  },
  provides: {
    "usage.history": usageHistory,
    "volume.fullness": volumeFullness,
    "network.traffic": networkTraffic,
  },
});

function asSaved(
  connection: Awaited<ReturnType<typeof commands.getPrometheusConnection>>
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
