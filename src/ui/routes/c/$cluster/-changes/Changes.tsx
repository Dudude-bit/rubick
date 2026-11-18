import { useMemo, useState } from "react";

import { ChangesTimeline } from "./ChangesTimeline";
import { RefusedWords } from "./RefusedWords";
import { ShowFilter } from "./ShowFilter";
import { TOGGLE } from "./toggle";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import {
  changesScreenSection,
  journalKindsWords,
  keepingWords,
  watchedSection,
} from "./changes-share";
import {
  changesKnownFrom,
  earlierRowsWords,
  merged,
  metaWords,
  newestFirst,
  quietSince,
  refusedWhere,
  spansCovering,
  spansWatching,
  timelineOf,
  unwatchedWords,
  watchedSince,
  watchedStretches,
  windowEnd,
  type ObservedSpan,
} from "@/lib/changes";
import { Eye, History, Lock } from "lucide-react";
import type { Show } from "@/generated/types";
import { cn, formatTimeUnit, formatWhen } from "@/lib/utils";
import { errorToShow } from "@/lib/error-utils";
import { useNow } from "@/hooks/useNow";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useTimeline, useTimelineHold } from "@/hooks/useTimeline";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

const WINDOWS = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
} as const;
type Window = keyof typeof WINDOWS;

const NO_SPANS: ObservedSpan[] = [];
const NO_KINDS: string[] = [];
const EVENTS = ["Event"];

const moment = (ms: number) => formatWhen(ms, "moment");

/** What this app saw happen across the cluster, and when it was not looking. */
export function Changes() {
  const t = useT();
  const { isConnected } = useClusterStore();
  const scope = useNamespaceScope();
  const [window, setWindow] = useState<Window>("24h");
  const [show, setShow] = useState<Show>("all");
  const now = useNow();
  useTimelineHold(isConnected);
  const read = useTimeline({
    scope: scope.scope,
    windowMs: WINDOWS[window],
    show,
    enabled: isConnected,
  });

  const ours = read.spans?.followed ?? NO_SPANS;
  const meta = read.spans?.meta ?? NO_SPANS;
  // Under warnings only the rows are the cluster's events: a stretch their
  // watch was refused is not one that had none.
  const events = show === "warnings" ? EVENTS : NO_KINDS;
  const covering = useMemo(
    () => spansCovering(ours, { kinds: events, namespaces: scope.scope }),
    [ours, events, scope.scope]
  );
  const end = windowEnd(ours, now);
  const knownFrom = changesKnownFrom(read);
  const items = useMemo(() => {
    const from = now - WINDOWS[window];
    const timeline = timelineOf({
      revisions: [],
      deliveries: [],
      helm: [],
      journal: read.rows,
      vouched: read.vouched,
      spans: covering,
      watching: spansWatching(ours, events),
      scope: scope.scope,
      window: { from, to: end },
      show,
      letGo: read.letGo,
      readFrom: read.readFrom,
    }).filter((item) => item.at !== null && item.at >= from);
    if (show === "warnings") return timeline;
    const stretches = watchedStretches(
      covering,
      timeline,
      Math.max(from, read.readFrom ?? from),
      end,
      scope.scope,
      knownFrom
    );
    return merged(timeline, stretches.sort(newestFirst));
  }, [
    read.rows,
    read.vouched,
    read.letGo,
    read.readFrom,
    ours,
    covering,
    events,
    now,
    end,
    window,
    scope.scope,
    show,
    knownFrom,
  ]);
  const running = ours.find((span) => span.to === null);
  // Under warnings only, a running span refused the Event watch is not
  // watching what the page shows: it names the refusal and nothing more.
  const open =
    show === "warnings" ? covering.find((span) => span.to === null) : running;
  // From the start of the unbroken watch, not of the span: a scope change
  // retires one span and opens the next at the same moment.
  const watching = open && {
    ...open,
    from: watchedSince(covering, end) ?? open.from,
  };
  const quiet = quietSince(watching, items, knownFrom, show);
  const refused = running && unwatchedWords(running, t);
  const earlier =
    watching && earlierRowsWords(ours, items, watching.from, t, moment);
  const keeping = keepingWords(read, t);
  const named = metaWords(meta, t, moment);
  const windowWords =
    window === "24h" ? formatTimeUnit(24, "hour") : formatTimeUnit(7, "day");

  // A read that failed or has not answered says nothing of watching, and
  // holds no rows to call the window empty by.
  const unread = read.read
    ? null
    : read.error
      ? t("changes", "readFailed", { reason: errorToShow(read.error) })
      : t("share", "stillReading");

  useShareSection("changes", () => [
    changesScreenSection(items, t, windowWords, show, unread),
    watchedSection(watching, ours, items, t, show, read, running),
  ]);

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={t("nav", "changes")} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <SectionHeader
        title={t("changes", "title")}
        count={
          watching || read.read ? (
            <>
              {watching
                ? t("changes", "watchingNow", {
                    since: moment(watching.from),
                  })
                : t("changes", "notWatchingNow")}
              {refused && running && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-warn"
                  title={[...refusedWhere(running)]
                    .filter(([, where]) => where.length > 0)
                    .map(([kind, where]) => `${kind}: ${where.join(", ")}`)
                    .join("\n")}
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  <RefusedWords span={running} />
                </span>
              )}
            </>
          ) : undefined
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
            <ShowFilter show={show} onShow={setShow} watching={running} />
            <div className="flex items-center gap-0.5" role="group">
              {(Object.keys(WINDOWS) as Window[]).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={window === candidate}
                  onClick={() => setWindow(candidate)}
                  className={cn(
                    TOGGLE,
                    "font-mono",
                    window === candidate ? "bg-sel text-fg" : "text-fg-mut"
                  )}
                >
                  {candidate === "24h"
                    ? formatTimeUnit(24, "hour")
                    : formatTimeUnit(7, "day")}
                </button>
              ))}
            </div>
            <ShareScreenAction
              screen={{ title: t("changes", "title"), scope: scope.scope }}
            />
          </>
        }
      />
      <Section className="min-h-0 flex-1">
        <SectionBody className="flex min-h-0 flex-1 flex-col">
          {keeping.map((line) => (
            <p
              key={line}
              className="px-1.5 py-1 text-xs text-warn"
              data-testid="changes-keeping"
            >
              {line}
            </p>
          ))}
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
                since: moment(quiet),
                kinds: journalKindsWords(t, watching),
              })}
            </p>
          )}
          {read.isPending ? (
            <p className="px-1.5 py-1 text-xs text-fg-fnt">
              {t("changes", "readingKept")}
            </p>
          ) : (
            read.read &&
            (items.length > 0 || quiet === null) && (
              <ChangesTimeline
                items={items}
                showObject
                fill
                onEnd={read.readFrom === null ? undefined : read.loadOlder}
                empty={
                  show === "warnings"
                    ? t("changes", "noWarningsInWindow")
                    : undefined
                }
              />
            )
          )}
          <p className="px-1.5 pt-2 text-[11px] text-fg-fnt">
            {t("changes", "clusterExplained")} {named.said}
            {named.open && unwatchedWords(named.open, t) && (
              <>
                {" · "}
                <RefusedWords span={named.open} />
              </>
            )}
          </p>
        </SectionBody>
      </Section>
    </div>
  );
}
