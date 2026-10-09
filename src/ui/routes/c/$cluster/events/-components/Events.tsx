import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  hashKey,
  keepPreviousData,
  skipToken,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useLiveQueries, useLiveQuery } from "@/hooks/useLiveQuery";
import { useWatchedList } from "@/hooks/useWatchedList";

import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { DataFreshness } from "@/components/ui/realtime";
import { EVENT_ROW } from "@/components/object/detail-blocks";
import { EventsTable } from "./EventsTable";
import { StoryCard } from "./StoryCard";
import { useHeldOrder } from "./held-rows";
import { RefusalWayOut, UnreadList } from "../../-list/UnreadList";
import { useListRefusal } from "../../-list/useListRefusal";
import { StaleRows } from "../../-list/StaleRows";
import { KindAbout } from "@/components/object/KindAbout";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import { eventsFiltersSection } from "./events-share";
import { eventsSection } from "@/lib/report-parts";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { errorToShow, isRefusal, normalizeTauriError } from "@/lib/error-utils";
import { spanWords } from "@/i18n/say";
import { filterEvents } from "@/lib/event-filter";
import { byNewest, newerEvent } from "@/lib/event-order";
import { scopeCacheKey } from "@/lib/namespace-scope";
import {
  sortStories,
  storiesOf,
  STORY_WINDOWS,
  WINDOW_MS,
  type Story,
  type StoryOrder,
  type StoryWindow,
} from "@/lib/event-stories";
import { useNow } from "@/hooks/useNow";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { STALE_TIMES } from "@/lib/refresh";
import { listQueryFor, ResourceType, toPlural } from "@/lib/resource-registry";
import { cn, formatTimeUnit } from "@/lib/utils";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import type { EventFilters, EventInfo, Scoped } from "@/generated/types";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";
import { formatCount } from "@/lib/count";

const TYPE_FILTERS: Array<{
  value: string;
  label: keyof typeof en.action;
}> = [
  { value: "all", label: "all" },
  { value: "Warning", label: "eventsWarnings" },
  { value: "Normal", label: "eventsNormal" },
];

const LIMITS = ["200", "500", "1000", "2000", "all"] as const;

type View = "stories" | "list";

const ORDERS: Array<{ value: StoryOrder; label: keyof typeof en.action }> = [
  { value: "warningsFirst", label: "warningsFirst" },
  { value: "newest", label: "newestFirst" },
];

function isWindow(value: string | undefined): value is StoryWindow {
  return (STORY_WINDOWS as readonly string[]).includes(value ?? "");
}

async function read(filters: EventFilters) {
  try {
    return await commands.listEvents(filters);
  } catch (err) {
    throw new Error(normalizeTauriError(err), { cause: err });
  }
}

const EVENTS = listQueryFor(ResourceType.Event);
const NO_DETAIL = () => [];
const NO_EVENTS: EventInfo[] = [];
const STORIES_FOLLOW_MS = 1000;

/** Draws the page again when the entry under `queryKey` changes, at most once per `everyMs`. */
function useWakeOnChange(queryKey: QueryKey, everyMs: number | null) {
  const client = useQueryClient();
  const [, wake] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (everyMs === null) return;
    const hash = hashKey(queryKey);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const off = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== hash) return;
      if (timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          last = Date.now();
          wake();
        },
        Math.max(0, last + everyMs - Date.now())
      );
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [client, queryKey, everyMs]);
}

/**
 * The last failure, kept while a retry is out. A poll that never answered
 * has no data, so React Query clears its error for each retry, and the page
 * read as fine for the length of every attempt.
 */
function useFailureUntilAnswered(error: Error | null, retrying: boolean) {
  const [last, setLast] = useState<Error | null>(error);
  if (error !== null && error !== last) setLast(error);
  if (error === null && !retrying && last !== null) setLast(null);
  return error ?? (retrying ? last : null);
}

function filtersFor(
  namespace: string,
  eventType: string,
  limit: number | null
): EventFilters {
  return {
    namespace,
    event_type: eventType === "all" ? null : eventType,
    limit,
    involved_object_name: null,
    involved_object_kind: null,
    field_selector: null,
  };
}

const keyOfStory = (story: Story) => story.key;

export function Events() {
  const t = useT();
  const { isConnected, currentNamespace } = useClusterStore();
  const scope = useNamespaceScope();
  const [eventType, setEventType] = useState<string>("all");
  const [eventLimit, setEventLimit] = useState<string>("500");
  const { view: viewParam, range, q: query = "" } = useAppSearch();
  const setSearch = useSetSearch();
  const view: View = viewParam === "list" ? "list" : "stories";
  const window: StoryWindow = isWindow(range) ? range : "1h";
  const [order, setOrder] = useState<StoryOrder>("warningsFirst");
  // In the address, like every other list's search: a term carried here from
  // another kind arrives as `?q=`, and a page that kept it in local state
  // showed every event while the address claimed it was filtered.
  const setQuery = (value: string) => setSearch({ q: value || undefined });
  const now = useNow();

  const limit = eventLimit === "all" ? null : Number(eventLimit);
  const several = scope.several;

  // Every event of the scope, kept by a watch: the first read arrives in the
  // watch's own batches, each under the IPC target, and after that only what
  // changed crosses. The type and the limit cut it here, so changing either
  // asks the cluster nothing.
  const cacheKey = useMemo(() => scopeCacheKey(scope.scope), [scope.scope]);
  const watchKey = useMemo(
    () => [...queryKeys.events(cacheKey), "watch"],
    [cacheKey]
  );
  const subscribe = useCallback(
    () => commands.subscribeEventWatch(scope.wire),
    [scope.wire]
  );
  const watch = useWatchedList<EventInfo>({
    enabled: isConnected,
    subscribe,
    queryKey: watchKey,
    detail: NO_DETAIL,
    reportFailure: toPlural(ResourceType.Event),
    order: newerEvent,
    // The overview counts events too, and re-reading it on every one of them
    // would cost more than the feed saves.
    recount: false,
  });
  // Stories fold the whole feed, so they follow the watch once a second, as
  // they followed the poll; the list follows every batch.
  const client = useQueryClient();
  const sampled =
    view === "stories" && client.getQueryData(watchKey) !== undefined;
  const streamed = useLiveQuery<Scoped<EventInfo>>({
    queryKey: watchKey,
    queryFn: skipToken,
    enabled: false,
    refresh: false,
    notifyOnChangeProps: sampled ? [] : undefined,
  });
  useWakeOnChange(watchKey, sampled ? STORIES_FOLLOW_MS : null);
  const watching = watch.live;

  // Where no watch runs, the feed is polled as it always was.
  const single = useLiveQuery({
    queryKey: [...queryKeys.events(currentNamespace), eventType, eventLimit],
    queryFn: () => read(filtersFor(currentNamespace, eventType, limit)),
    enabled: isConnected && !several && !watching,
    refresh: "fast",
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.fast,
    refetchOnWindowFocus: false,
  });

  // One request per selected namespace, rather than one cluster-wide request
  // narrowed afterwards.
  //
  // The limit is a sentence about what is on screen — "latest 500" — so it
  // has to be counted against the scope the reader chose, and only the API
  // server can count it per namespace. Spent cluster-wide it goes to whoever
  // is loudest: a busy kube-system fills all 500 rows and the page prints "No
  // events in 2 namespaces yet" while prod is emitting. Each namespace is
  // asked for the whole limit rather than a share of it, because a share
  // would starve the noisy namespace and go unused in the quiet one; the
  // join is cut back to the limit below. It costs one request per selected
  // namespace, which is what `SCOPE_LIMIT` bounds.
  const parts = useLiveQueries<EventInfo[]>({
    refresh: "fast",
    // `placeholderData: keepPreviousData` is not missing from these: it does
    // nothing in a fan-out. `useQueries` matches observers by query hash, so
    // changing the filter re-keys every part onto a brand-new `QueryObserver`,
    // and the previous data it would keep lives on the observer that was just
    // replaced. The feed draws its skeleton until every namespace has answered
    // the question actually being asked, which is one fast read away.
    queries: (several && !watching ? scope.scope : []).map((namespace) => ({
      queryKey: [...queryKeys.events(namespace), eventType, eventLimit],
      queryFn: () => read(filtersFor(namespace, eventType, limit)),
      enabled: isConnected,
      staleTime: STALE_TIMES.fast,
      // The group re-reads every part on the way back on its own
      // (`useLiveQueries`), which is the promise this cannot be switched off
      // without. React Query's focus refetch on top of that is a second wave
      // of one request per namespace for an answer already on its way.
      refetchOnWindowFocus: false,
    })),
  });

  const answers = parts.data;
  const polled = useMemo(
    () =>
      watching
        ? undefined
        : several
          ? answers.some((part) => part !== undefined)
            ? // Newest first, the order each part arrived in and the one the
              // cut below depends on.
              answers.flatMap((part) => part ?? []).sort(byNewest)
            : undefined
          : single.data,
    [watching, several, answers, single.data]
  );
  const kept = streamed.data?.rows;
  // A watch that failed leaves its rows on screen until a poll answers.
  const fromWatch = watching || (polled === undefined && kept !== undefined);
  // The read can fail, and until now nothing here asked. An empty feed then
  // drew the quiet-scope sentence, which for the stories tab went as far as
  // "the read succeeded and returned no events", a claim about a request that
  // came back 403. In a fan-out one refused namespace is enough: the rest may
  // have answered, but what is on screen is no longer the scope's whole story.
  const failed = useFailureUntilAnswered(
    watching ? null : several ? parts.error : single.error,
    !watching && (several ? parts.isLoading : single.isLoading)
  );
  // Refused now, the feed is refused, whatever an earlier read showed.
  const refused = failed !== null && isRefusal(failed);
  const { pool, windowFull } = useMemo(() => {
    if (refused) return { pool: NO_EVENTS, windowFull: false };
    if (!fromWatch) {
      const rows = polled ?? [];
      return { pool: rows, windowFull: limit !== null && rows.length >= limit };
    }
    const all = kept ?? [];
    const typed =
      eventType === "all" ? all : all.filter((e) => e.type === eventType);
    return limit !== null && typed.length > limit
      ? { pool: typed.slice(0, limit), windowFull: true }
      : { pool: typed, windowFull: false };
  }, [refused, fromWatch, polled, kept, eventType, limit]);

  // Narrowed before the cut, not after it. The limit buys a pool of the
  // latest N; searching what is left after the cut would search the newest
  // rows only and report "none" about a cluster that has plenty, just older
  // than the window. Filtering first spends the pool on the rows asked for.
  const matching = useMemo(() => filterEvents(pool, query), [pool, query]);

  // The type selector narrows the read itself and the search narrows what is
  // left, so a fold over either cannot tell "nothing went wrong" from "the
  // warnings were filtered out before I saw them".
  const narrowed = eventType !== "all" || query.trim() !== "";
  // The oldest moment the read actually covers. A pool cut at the limit holds
  // only the latest N, so anything older than its last row was never read —
  // and an empty slice of the strip there means nobody looked.
  const readFrom = useMemo(() => {
    if (!windowFull) return null;
    const oldest = pool.at(-1)?.lastTimestamp;
    const parsed = oldest ? Date.parse(oldest) : Number.NaN;
    return Number.isNaN(parsed) ? null : parsed;
  }, [windowFull, pool]);
  const storyOptions = useMemo(
    () => ({ now, windowMs: WINDOW_MS[window], narrowed, readFrom }),
    [now, window, narrowed, readFrom]
  );
  const stories = useMemo(
    () =>
      view === "stories"
        ? sortStories(storiesOf(matching, storyOptions), order)
        : [],
    [view, matching, storyOptions, order]
  );
  const [pointed, setPointed] = useState(false);
  const shownStories = useHeldOrder(
    stories,
    pointed,
    [cacheKey, eventType, eventLimit, query, window, order].join("\n"),
    keyOfStory
  );

  const isLoading = watching
    ? kept === undefined
    : !fromWatch && (several ? parts.isLoading : single.isLoading);
  const freshness = fromWatch
    ? streamed.freshness
    : several
      ? parts.freshness
      : single.freshness;
  // A read that failed over rows it had: they stay, said to be old. A
  // namespace of the fan-out that never answered is unread, not old.
  const stale =
    failed !== null &&
    pool.length > 0 &&
    (fromWatch || (several ? parts.freshness.stale : single.freshness.stale));

  // Two ceilings, and a filter makes them diverge. `windowFull` is about
  // the pool the limit bought — cut by the apiserver per namespace and by
  // the join above — and it is the only one that says whether anything was
  // left unread. `capped` is about the list on screen. Unfiltered they are
  // the same number; filtered, `matching` can be three rows out of a pool
  // that stopped at five hundred, and reporting *that* as uncapped tells
  // the reader the search was exhaustive when it was not.
  const capped = limit !== null && matching.length >= limit;
  const events = capped ? matching.slice(0, limit) : matching;
  const filtering = query.trim() !== "";
  // In stories view the cards cover the window; counting the whole pool
  // beside them puts two numbers about two different spans on one line, and
  // the reader has no way to tell which is which.
  const counted =
    view === "stories" ? stories.flatMap((story) => story.events) : events;
  const warningCount = counted.filter((e) => e.type === "Warning").length;
  const normalCount = counted.length - warningCount;
  const showSkeleton = isLoading && events.length === 0;
  const nothingRead = failed !== null && pool.length === 0;
  const listed = view === "list" && !showSkeleton && !(failed && !stale);

  useShareSection("events", () => [
    eventsSection(
      counted,
      failed
        ? t("hints", "notReadEvents", { reason: errorToShow(failed) })
        : null,
      true
    ),
    eventsFiltersSection(
      view,
      window,
      eventType,
      query,
      eventLimit,
      scope.scope,
      t
    ),
  ]);

  if (!isConnected) {
    return (
      <ConnectClusterEmptyState resourceLabel={toPlural(ResourceType.Event)} />
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 animate-in fade-in duration-200",
        listed && "h-full min-h-0"
      )}
    >
      <SectionHeader
        title="Events"
        description={<KindAbout kind={ResourceType.Event} />}
        count={
          showSkeleton || nothingRead
            ? undefined
            : summarise(
                t,
                warningCount,
                normalCount,
                windowFull ? eventLimit : null,
                view === "stories" ? { n: stories.length, window } : null
              )
        }
        actions={
          <>
            {!nothingRead && (
              <>
                <span
                  role="tablist"
                  aria-label={t("columns", "view")}
                  className="flex items-center gap-0.5"
                >
                  {(["stories", "list"] as const).map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      role="tab"
                      aria-selected={view === candidate}
                      onClick={() =>
                        setSearch({
                          view: candidate === "stories" ? undefined : "list",
                        })
                      }
                      className={cn(
                        "h-6 whitespace-nowrap rounded px-1.5 text-[11px] transition-colors hover:bg-hover",
                        view === candidate ? "bg-sel text-fg" : "text-fg-mut"
                      )}
                    >
                      {t(
                        "action",
                        candidate === "stories" ? "eventsStories" : "eventsAll"
                      )}
                    </button>
                  ))}
                </span>
                {view === "stories" ? (
                  <>
                    <div
                      className="flex items-center gap-0.5"
                      role="group"
                      aria-label={t("action", "storyWindow")}
                    >
                      {STORY_WINDOWS.map((candidate) => (
                        <button
                          key={candidate}
                          type="button"
                          aria-pressed={window === candidate}
                          onClick={() =>
                            setSearch({
                              range: candidate === "1h" ? undefined : candidate,
                            })
                          }
                          className={cn(
                            "h-6 whitespace-nowrap rounded px-1.5 font-mono text-[11px] transition-colors hover:bg-hover",
                            window === candidate
                              ? "bg-sel text-fg"
                              : "text-fg-mut"
                          )}
                        >
                          {windowWords(candidate)}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-0.5" role="group">
                      {ORDERS.map((candidate) => (
                        <button
                          key={candidate.value}
                          type="button"
                          aria-pressed={order === candidate.value}
                          onClick={() => setOrder(candidate.value)}
                          className={cn(
                            "h-6 whitespace-nowrap rounded px-1.5 text-[11px] transition-colors hover:bg-hover",
                            order === candidate.value
                              ? "bg-sel text-fg"
                              : "text-fg-mut"
                          )}
                        >
                          {t("action", candidate.label)}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
                {/* Same shape as the lists' search box: a text entry, not a
                  panel, so it only draws a background once it is in use. */}
                <div className="flex h-6 items-center gap-1.5 rounded px-1.5 text-fg-fnt transition-colors hover:bg-hover focus-within:bg-hover">
                  <Search className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <input
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    aria-label={t("action", "filterEventsPlaceholder")}
                    placeholder={t("action", "filterEventsPlaceholder")}
                    className="w-36 bg-transparent text-[11px] text-fg outline-hidden placeholder:text-fg-fnt"
                  />
                </div>
                <div
                  className="flex items-center gap-0.5"
                  role="group"
                  aria-label={t("action", "eventType")}
                >
                  {TYPE_FILTERS.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      aria-pressed={eventType === filter.value}
                      onClick={() => setEventType(filter.value)}
                      className={cn(
                        "h-6 whitespace-nowrap rounded px-1.5 text-[11px] transition-colors hover:bg-hover",
                        eventType === filter.value
                          ? "bg-sel text-fg"
                          : "text-fg-mut"
                      )}
                    >
                      {t("action", filter.label)}
                    </button>
                  ))}
                </div>
                <Select value={eventLimit} onValueChange={setEventLimit}>
                  <SelectTrigger
                    aria-label={t("action", "eventsFetched")}
                    className="h-6 w-auto shrink-0 gap-1 whitespace-nowrap border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LIMITS.map((limit) => (
                      <SelectItem key={limit} value={limit}>
                        {limit === "all"
                          ? t("action", "noLimit")
                          : t("action", "latestN", {
                              n: formatCount(Number(limit)),
                            })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            <DataFreshness
              dataUpdatedAt={freshness.dataUpdatedAt}
              live={watching && !watch.resyncing}
              slowed={!fromWatch && freshness.slowed}
              stale={stale || (nothingRead && !isRefusal(failed))}
            />
            <ShareScreenAction
              screen={{ title: "Events", namespace: currentNamespace }}
            />
          </>
        }
      />
      <Section className={cn(listed && "min-h-0")}>
        <SectionBody className={cn(listed && "flex min-h-0 flex-col")}>
          {stale && (
            <StaleRows
              label="events"
              since={freshness.dataUpdatedAt}
              error={failed}
              onRetry={() =>
                several ? parts.refetch() : void single.refetch()
              }
            />
          )}
          {showSkeleton ? (
            <EventsSkeleton />
          ) : failed && !stale ? (
            // Before either tab's empty state. Both of them are sentences
            // about what the cluster holds, and neither is answerable from a
            // read that did not come back — the API server's own words are.
            <UnreadFeed
              failed={failed}
              everyNamespace={scope.isAll}
              scopeWords={scope.inWords}
              onRetry={() =>
                several ? parts.refetch() : void single.refetch()
              }
            />
          ) : view === "stories" ? (
            stories.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-fg-fnt">
                {filtering
                  ? t("empty", "noStoriesMatch", {
                      scope: scope.inWords,
                      query: query.trim(),
                    })
                  : windowFull
                    ? // The pool stopped at the limit, so "nothing happened"
                      // is about the latest N events and not about the
                      // window — the story being looked for may be one page
                      // older. The list tab has said this since it shipped.
                      t("empty", "noStoriesInWindowCapped", {
                        scope: scope.inWords,
                        range: spanWords(WINDOW_MS[window], t),
                        n: eventLimit,
                      })
                    : t("empty", "noStoriesInWindow", {
                        scope: scope.inWords,
                        range: spanWords(WINDOW_MS[window], t),
                      })}
              </p>
            ) : (
              <div
                className="flex flex-col gap-2 p-1.5"
                onPointerEnter={() => setPointed(true)}
                onPointerLeave={() => setPointed(false)}
              >
                {shownStories.map((story) => (
                  <StoryCard
                    key={story.key}
                    story={story}
                    options={storyOptions}
                    showNamespace={!currentNamespace}
                  />
                ))}
                <p className="px-1 text-[11px] text-fg-fnt">
                  {t("readings", "storiesExplained")}
                </p>
              </div>
            )
          ) : (
            <EventsTable
              events={events}
              showNamespace={!currentNamespace}
              question={[cacheKey, eventType, eventLimit, query].join("\n")}
              // A feed filtered down to nothing has not told the reader
              // their scope is quiet — it has told them their query missed.
              // Three states, not two: the scope is quiet, the query
              // missed everything that was read, or the query missed
              // everything that was read *and* the reading stopped at the
              // limit. The last one must not be worded as the second — the
              // events being looked for may be one page older.
              emptyMessage={
                filtering
                  ? windowFull
                    ? t("empty", "noEventsMatchInWindow", {
                        n: eventLimit,
                        scope: scope.inWords,
                        query: query.trim(),
                      })
                    : t("empty", "noEventsMatch", {
                        scope: scope.inWords,
                        query: query.trim(),
                      })
                  : t("empty", "noEventsInScope", { scope: scope.inWords })
              }
            />
          )}
        </SectionBody>
      </Section>
    </div>
  );
}

/** A feed nobody could read, said the way the lists say it. */
function UnreadFeed({
  failed,
  everyNamespace,
  scopeWords,
  onRetry,
}: {
  failed: Error;
  everyNamespace: boolean;
  scopeWords: string;
  onRetry: () => void;
}) {
  const t = useT();
  const refusal = useListRefusal(failed, everyNamespace, EVENTS);
  return (
    <div className="px-1.5">
      <UnreadList
        error={failed}
        words={
          isRefusal(failed)
            ? refusal.words
            : t("empty", "eventsRefused", { scope: scopeWords })
        }
        onRetry={onRetry}
      >
        <RefusalWayOut refusal={refusal} />
      </UnreadList>
    </div>
  );
}

/**
 * Worst first. Counts Event objects, as kubectl and the sidebar do, and names
 * the span they cover so a story's occurrences are not read as the same unit.
 */
function summarise(
  t: ReturnType<typeof useT>,
  warnings: number,
  normal: number,
  cappedAt: string | null,
  stories: { n: number; window: StoryWindow } | null
): string {
  const parts: string[] = [];
  if (stories !== null) parts.push(t("count", "stories", { n: stories.n }));
  if (warnings > 0) parts.push(t("count", "warningEvents", { n: warnings }));
  if (normal > 0) parts.push(t("count", "normalEvents", { n: normal }));
  if (parts.length === 0) parts.push(t("empty", "noneInline"));
  if (stories !== null)
    parts.push(
      t("count", "inStoryWindow", { span: windowWords(stories.window) })
    );
  if (cappedAt)
    parts.push(t("count", "latestKept", { n: formatCount(Number(cappedAt)) }));
  return parts.join(" · ");
}

const windowWords = (window: StoryWindow) =>
  formatTimeUnit(
    Number.parseInt(window, 10),
    window.endsWith("m") ? "minute" : "hour"
  );

function EventsSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className={EVENT_ROW}>
          <span />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-full" />
          <span />
          <Skeleton className="h-3 w-6 justify-self-end" />
        </div>
      ))}
    </div>
  );
}
