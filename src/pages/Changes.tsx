import { useMemo, useState } from "react";

import { ChangesTimeline } from "@/components/changes/ChangesTimeline";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { timelineOf } from "@/lib/changes";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

const WINDOWS = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
} as const;
type Window = keyof typeof WINDOWS;

/** What this app saw change across the cluster's workloads, and when it was not looking. */
export function Changes() {
  const t = useT();
  const { isConnected, currentContext } = useClusterStore();
  const scope = useNamespaceScope();
  const [window, setWindow] = useState<Window>("24h");
  const now = useNow();
  const entries = useChangeJournalStore((s) => s.entries);
  const spans = useChangeJournalStore((s) => s.spans);

  const mine = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.context === currentContext &&
          (scope.scope.length === 0 || scope.scope.includes(entry.namespace))
      ),
    [entries, currentContext, scope.scope]
  );
  const items = useMemo(
    () =>
      timelineOf({
        revisions: [],
        deliveries: [],
        helm: [],
        journal: mine,
        spans: currentContext ? (spans[currentContext] ?? []) : [],
        window: { from: now - WINDOWS[window], to: now },
      }).filter((item) => item.at !== null && item.at >= now - WINDOWS[window]),
    [mine, spans, currentContext, now, window]
  );
  const watching = currentContext
    ? (spans[currentContext] ?? []).find((span) => span.to === null)
    : undefined;

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={t("nav", "changes")} />;
  }

  return (
    <div className="flex flex-col gap-2 animate-in fade-in duration-200">
      <SectionHeader
        title={t("changes", "title")}
        count={
          watching
            ? t("changes", "watchingNow", {
                since: new Date(watching.from).toLocaleTimeString(),
              })
            : t("changes", "notWatchingNow")
        }
        actions={
          <div className="flex items-center gap-0.5" role="group">
            {(Object.keys(WINDOWS) as Window[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={window === candidate}
                onClick={() => setWindow(candidate)}
                className={cn(
                  "h-6 rounded px-1.5 font-mono text-[11px] transition-colors hover:bg-hover",
                  window === candidate ? "bg-sel text-fg" : "text-fg-mut"
                )}
              >
                {candidate}
              </button>
            ))}
          </div>
        }
      />
      <Section>
        <SectionBody>
          <ChangesTimeline items={items} showObject />
          <p className="px-1.5 pt-2 text-[11px] text-fg-fnt">
            {t("changes", "clusterExplained")}
          </p>
        </SectionBody>
      </Section>
    </div>
  );
}
