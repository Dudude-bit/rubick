import { useMemo, useState } from "react";

import { SegmentedControl } from "@/components/ui/states";
import { ChangesTimeline } from "./ChangesTimeline";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import {
  changesScreenSection,
  journalKindsWords,
  watchedSection,
} from "./changes-share";
import {
  earlierRowsWords,
  quietSince,
  refusedWhere,
  spansCovering,
  spansWatching,
  timelineOf,
  unwatchedWords,
  watchedSince,
  watchedStretches,
  windowEnd,
} from "@/lib/changes";
import { Eye, History, Lock } from "lucide-react";
import { formatTimeUnit, formatWhen } from "@/lib/utils";
import { useNow } from "@/hooks/useNow";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useChangeJournalStore } from "@/stores/changeJournalStore";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

const WINDOWS = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
} as const;
type Range = keyof typeof WINDOWS;

const moment = (ms: number) => formatWhen(ms, "moment");

/** What this app saw change across the cluster's workloads, and when it was not looking. */
export function Changes() {
  const t = useT();
  const { isConnected, currentContext } = useClusterStore();
  const scope = useNamespaceScope();
  const [range, setRange] = useState<Range>("24h");
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
  const ours = useMemo(
    () => (currentContext ? (spans[currentContext] ?? []) : []),
    [spans, currentContext]
  );
  const covering = useMemo(
    () => spansCovering(ours, { kinds: [], namespaces: scope.scope }),
    [ours, scope.scope]
  );
  const end = windowEnd(ours, now);
  const items = useMemo(() => {
    const from = now - WINDOWS[range];
    const timeline = timelineOf({
      revisions: [],
      deliveries: [],
      helm: [],
      journal: mine,
      spans: covering,
      watching: spansWatching(ours, []),
      scope: scope.scope,
      window: { from, to: end },
    }).filter((item) => item.at !== null && item.at >= from);
    return [
      ...timeline,
      ...watchedStretches(covering, timeline, from, end, scope.scope),
    ].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  }, [mine, ours, covering, now, end, range, scope.scope]);
  const open = ours.find((span) => span.to === null);
  // From the start of the unbroken watch, not of the span: a scope change
  // retires one span and opens the next at the same moment.
  const watching = open && {
    ...open,
    from: watchedSince(covering, end) ?? open.from,
  };
  const quiet = quietSince(watching, items);
  const refused = watching && unwatchedWords(watching, t);
  const earlier =
    watching && earlierRowsWords(ours, items, watching.from, t, moment);

  useShareSection("changes", () => [
    changesScreenSection(
      items,
      t,
      range === "24h" ? formatTimeUnit(24, "hour") : formatTimeUnit(7, "day")
    ),
    watchedSection(watching, ours, items, t),
  ]);

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={t("nav", "changes")} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionHeader
        title={t("changes", "title")}
        count={
          watching ? (
            <>
              {t("changes", "watchingNow", {
                since: formatWhen(watching.from, "clock"),
              })}
              {refused && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-warn"
                  title={[...refusedWhere(watching)]
                    .filter(([, where]) => where.length > 0)
                    .map(([kind, where]) => `${kind}: ${where.join(", ")}`)
                    .join("\n")}
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  {refused}
                </span>
              )}
            </>
          ) : (
            t("changes", "notWatchingNow")
          )
        }
        description={
          earlier && (
            <span className="inline-flex items-center gap-1">
              <History className="h-3 w-3 flex-none" aria-hidden="true" />
              {earlier}
            </span>
          )
        }
        actions={
          <>
            <SegmentedControl
              label={t("changes", "range")}
              value={range}
              onChange={setRange}
              mono
              segments={(Object.keys(WINDOWS) as Range[]).map((candidate) => ({
                value: candidate,
                label:
                  candidate === "24h"
                    ? formatTimeUnit(24, "hour")
                    : formatTimeUnit(7, "day"),
              }))}
            />
            <ShareScreenAction
              screen={{ title: t("changes", "title"), scope: scope.scope }}
            />
          </>
        }
      />
      <Section>
        <SectionBody>
          {quiet !== null && (
            <p
              className="flex items-center gap-1.5 px-1.5 pb-1 text-xs text-fg-mut"
              data-testid="changes-quiet"
            >
              <Eye
                className="h-3.5 w-3.5 flex-none text-fg-fnt"
                aria-hidden="true"
              />
              {t("changes", "nothingRecordedSince", {
                since: formatWhen(quiet, "clock"),
                kinds: journalKindsWords(t, watching),
              })}
            </p>
          )}
          {(items.length > 0 || quiet === null) && (
            <ChangesTimeline items={items} showObject />
          )}
          <p className="px-1.5 pt-2 text-caption text-fg-fnt">
            {t("changes", "clusterExplained", { kinds: journalKindsWords(t) })}
          </p>
        </SectionBody>
      </Section>
    </div>
  );
}
