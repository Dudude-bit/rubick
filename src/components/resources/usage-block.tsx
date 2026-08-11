/**
 * The Usage block, on every page that has one.
 *
 * Everything a detail page needs to say about resource consumption lives
 * here so the answer cannot drift between kinds — a chart on the Pod page
 * and a bar on the Deployment page would be worse than bars on both.
 */
import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Section, SectionHeader } from "@/components/ui/section";
import { UsageRow } from "@/components/resources/detail-blocks";
import { TrafficChart } from "@/components/resources/traffic-chart";
import {
  NO_LIMIT_NOTE,
  UsageChart,
  WATCHING_NOTE,
} from "@/components/resources/usage-chart";
import { useUsageHistory } from "@/hooks/useUsageHistory";
import { useCapabilityState, USAGE_RANGES } from "@/integrations";
import type { UsageRange, UsageScope, VolumeFullness } from "@/integrations";
import { normalizeTauriError } from "@/lib/error-utils";
import { formatQuantity } from "@/lib/metric-format";
import { watchedFor } from "@/lib/usage-history";
import { storageSummary } from "@/lib/storage-summary";
import type { MetricsStatus, ResourceConnections } from "@/generated/types";

export interface UsageBlockProps {
  /** "Usage" on a workload, "Headroom" on a node. */
  title?: string;
  /** The kind, for the buffer key. */
  kind: string;
  /** Identity of the object being charted. A different uid is a different
   *  buffer, which is how a replaced pod starts a fresh line. */
  uid: string | null | undefined;
  /** What the block is measuring over, e.g. "summed over 3 pods". */
  scope?: string;
  cpu: number | null | undefined;
  memory: number | null | undefined;
  cpuLimit: number | null;
  memoryLimit: number | null;
  /** What the ceiling is called here: a pod has limits, a node a capacity. */
  limitNoun?: string;
  /** The sentence shown when there is no ceiling at all. */
  noLimitNote?: string;
  restarts?: number | null;
  /** `dataUpdatedAt` of the metrics query. */
  sampledAt: number | null | undefined;
  status: MetricsStatus | null;
  /** Drives the storage summary; already fetched by every page with a
   *  Connections tab, so this costs nothing. */
  connections?: ResourceConnections | null;
  /** Extra rows below the charts — the node's pod tally, which is a count
   *  from the pod list rather than a reading from metrics-server. */
  children?: React.ReactNode;
  /**
   * What a history supplier would be asked about.
   *
   * Optional, and its absence is not a degraded state: a caller that has not
   * said what it is looking at cannot be answered for, so the ranges stay
   * dimmed exactly as they were before any of this existed. The block never
   * guesses a scope from `kind` and `uid` — a wrong scope draws a confident
   * chart of somebody else's workload.
   */
  history?: UsageScope;
  /**
   * Whether anything is running behind this block.
   *
   * False on a finished Job, a suspended CronJob or a Deployment scaled to
   * zero, and only ever set where a supplier can answer for the past —
   * without one there is nothing to draw and the caller says so in words
   * instead. What it turns off is every claim about *now*: no sample is
   * recorded into the watched buffer, the caption drops the live-window
   * label rather than counting up a window nobody is watching, and the
   * bands report their peak instead of a last reading the reader would take
   * for a current one.
   */
  live?: boolean;
  /**
   * Why there is nothing running, in the caller's own words.
   *
   * Only read when {@link live} is false, and finished here rather than by
   * the caller because only this block knows whether the supplier came back
   * with anything: "this is what Prometheus kept" under two empty rows is the
   * page promising a past that was never recorded.
   */
  idleNote?: string;
}

export function UsageBlock({
  title = "Usage",
  kind,
  uid,
  scope,
  cpu,
  memory,
  cpuLimit,
  memoryLimit,
  limitNoun = "limit",
  noLimitNote = NO_LIMIT_NOTE,
  restarts,
  sampledAt,
  status,
  connections,
  children,
  history,
  live = true,
  idleNote,
}: UsageBlockProps) {
  const available = status === null || status.status === "available";
  /** Nothing declares a ceiling for either measure. */
  const neither =
    (cpuLimit === null || cpuLimit <= 0) &&
    (memoryLimit === null || memoryLimit <= 0);

  const samples = useUsageHistory({
    kind,
    uid,
    cpuMillicores: cpu,
    memoryBytes: memory,
    restarts,
    sampledAt,
    enabled: available && live,
  });

  const storage = React.useMemo(
    () => storageSummary(connections),
    [connections]
  );

  const past = useRangedHistory(history, available, live);

  // The span between the first and last readings, so the caption cannot
  // keep counting up while the metrics query is failing.
  const watched = samples.length > 0 ? watchedFor(samples) : null;

  // Both bands read the same buffer, so "watching from now" and "no limit
  // set" are facts about the workload rather than about CPU and then again
  // about memory. Said once, under the pair.
  // Null until the supplier has answered; false when it answered with an
  // empty window, which is a different sentence from "not yet".
  const kept = past.window === null ? null : past.window.samples.length > 0;

  const shared = !live
    ? // A ceiling is only worth naming beside a series that can be read
      // against it. Under two "not reporting" rows it is noise.
      neither && kept
      ? noLimitNote
      : null
    : available && samples.length > 0 && samples.length < 2
      ? WATCHING_NOTE
      : available && samples.length >= 2 && neither
        ? noLimitNote
        : null;

  // The integration extends the core answer and never replaces it: until a
  // range has actually arrived, this is the watched window, unchanged.
  const drawing = past.window ?? { samples, resolution: null };

  const caption = !available
    ? // The block cannot promise a comparison the workload does not
      // declare — that pairing is what made an empty track read as 0%.
      neither
      ? `no ${limitNoun}s declared`
      : `against declared ${limitNoun}s`
    : past.window !== null
      ? [scope, `from ${past.endpoint}`, past.window.resolution]
          .filter(Boolean)
          .join(" · ")
      : [
          scope,
          // Nothing is running, so there is no window being watched and no
          // honest way to say how long it has been watched for. The range
          // picker beside it is the whole offer, and the caption is just the
          // scope — "watched since you opened this page · 0s" would be the
          // block counting up a thing it is not doing.
          !live
            ? null
            : watched === null
              ? "watching from now"
              : `watched since you opened this page · ${watched} so far`,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <Section>
      <SectionHeader
        title={title}
        count={caption}
        actions={
          available ? (
            <RangePicker
              enabled={past.enabled}
              selected={past.range}
              onSelect={past.select}
              loading={past.loading}
            />
          ) : undefined
        }
      />
      <div>
        {available ? (
          <>
            <UsageChart
              label="CPU"
              type="cpu"
              samples={drawing.samples}
              limit={cpuLimit}
              limitNoun={limitNoun}
              noLimitNote={neither ? null : noLimitNote}
              current={cpu ?? null}
              suppressNote={shared !== null}
              live={live}
            />
            <UsageChart
              label="Memory"
              type="memory"
              samples={drawing.samples}
              limit={memoryLimit}
              limitNoun={limitNoun}
              noLimitNote={neither ? null : noLimitNote}
              current={memory ?? null}
              suppressNote={shared !== null}
              live={live}
            />
            {past.traffic && <TrafficChart window={past.traffic} />}
            {shared && (
              <p className="pb-1 pl-[104px] pr-1.5 text-[11px] leading-snug text-fg-fnt">
                {shared}
              </p>
            )}
            {!live && idleNote && (
              <p className="px-1.5 pb-1 pt-1 text-[11px] leading-snug text-fg-fnt">
                {idleNote}{" "}
                {kept === null
                  ? `Reading what ${past.vendor} kept from while it was running.`
                  : kept
                    ? `There is no live line to draw — this is what ${past.vendor} kept from while it was running.`
                    : `${past.vendor} has nothing for it in this window either — try a longer one, or it ran before this one was watching.`}
              </p>
            )}
            <HistoryNote state={past} />
          </>
        ) : (
          <>
            {/* Not an empty plot. metrics-server missing is a cluster the
             *  reader can fix, and the row that says so already exists. */}
            <UsageRow label="CPU" used={null} total={cpuLimit} type="cpu" />
            <UsageRow
              label="Memory"
              used={null}
              total={memoryLimit}
              type="memory"
            />
          </>
        )}
        {children}
      </div>
      {storage && <StorageRow summary={storage} />}
    </Section>
  );
}

/**
 * The offer, the loss, or nothing — the three states a configured
 * integration owes the surface it upgrades.
 *
 * The middle one is the trap the whole seam exists to close. An integration
 * that silently falls back looks identical to one that was never configured,
 * and the reader concludes the feature is broken rather than that their
 * Prometheus is. Saying which one it is costs a line.
 */
function HistoryNote({ state }: { state: RangedHistory }) {
  if (state.status === "unreachable") {
    return (
      <p className="pb-1 pl-[104px] pr-1.5 text-[11px] leading-snug text-warn">
        {state.vendor} did not answer — {state.reason}. This is the window the
        app watched itself; the longer ranges are gone until it is back.
      </p>
    );
  }
  if (state.status === "absent" && state.offerable) {
    return (
      <p className="pb-1 pl-[104px] pr-1.5 text-[11px] leading-snug text-fg-fnt">
        Longer than this needs a Prometheus —{" "}
        <Link to="/settings/integrations" className="text-info hover:underline">
          connect one
        </Link>
        .
      </p>
    );
  }
  return null;
}

/**
 * Live where a supplier is answering, dimmed and inert where none is.
 *
 * `disabled` rather than a styled span, so assistive tech is told the same
 * thing the dimming says — and the title names what is missing, because a
 * control that is off for a reason the reader cannot discover is worse than
 * no control.
 */
function RangePicker({
  enabled,
  selected,
  onSelect,
  loading,
}: {
  enabled: boolean;
  selected: UsageRange | null;
  onSelect: (range: UsageRange | null) => void;
  loading: boolean;
}) {
  return (
    <span className="flex items-center gap-0.5">
      {loading && (
        <span className="mr-1 text-[10px] text-fg-fnt">reading…</span>
      )}
      {USAGE_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          disabled={!enabled}
          aria-pressed={selected === range}
          onClick={() => onSelect(selected === range ? null : range)}
          title={
            enabled
              ? `Ask for the last ${range}`
              : "Needs a Prometheus — metrics-server keeps no history to range over"
          }
          className={
            enabled
              ? selected === range
                ? "rounded bg-sel px-1.5 py-0.5 text-[11px] text-fg"
                : "rounded px-1.5 py-0.5 text-[11px] text-fg-mut hover:bg-hover hover:text-fg"
              : "cursor-default rounded px-1.5 py-0.5 text-[11px] text-fg-mut opacity-40"
          }
        >
          {range}
        </button>
      ))}
    </span>
  );
}

interface RangedHistory {
  /** Which of the three states the supplier is in. */
  status: "absent" | "unreachable" | "ready";
  /** True only where a range could actually be asked for and drawn. */
  enabled: boolean;
  /** Whether the quiet offer is worth making — see {@link HistoryNote}. */
  offerable: boolean;
  range: UsageRange | null;
  select: (range: UsageRange | null) => void;
  loading: boolean;
  window: { samples: readonly UsageSampleLike[]; resolution: string } | null;
  traffic: TrafficLike | null;
  endpoint: string;
  vendor: string;
  reason: string;
}

type UsageSampleLike = Parameters<typeof watchedFor>[0][number];
type TrafficLike = NonNullable<
  React.ComponentProps<typeof TrafficChart>["window"]
>;

/**
 * The past, where something can answer for it.
 *
 * Nothing here blocks the live chart. The block renders its watched window
 * on the first frame and this fills in beside it — a page that waited on
 * somebody else's Prometheus before drawing the numbers it already had would
 * be worse with the integration than without one, which is the single thing
 * the seam exists to prevent.
 */
function useRangedHistory(
  scope: UsageScope | undefined,
  available: boolean,
  live: boolean
): RangedHistory {
  const power = useCapabilityState("usage.history");
  const trafficPower = useCapabilityState("network.traffic");
  // A block with nothing running opens on a range instead of on nothing.
  // There is no live window for it to fall back to, so an unselected picker
  // would draw an empty plot over a supplier that has the answer — and the
  // reader would have to guess that the fix is a button they were given no
  // reason to press. 6h rather than 15m because the workloads this happens
  // to are the ones that stopped, often hours ago.
  const [range, setRange] = React.useState<UsageRange | null>(
    live ? null : "6h"
  );

  const ready = power.state === "ready";
  const enabled = ready && scope !== undefined && available;

  const query = useQuery({
    queryKey: ["usage-history", scope, range],
    queryFn: () =>
      (power as Extract<typeof power, { state: "ready" }>).use({
        scope: scope!,
        range: range!,
      }),
    enabled: enabled && range !== null,
    // A range query is expensive on somebody else's server and the window it
    // describes barely moves; re-asking on every tab switch would be rude.
    staleTime: 30_000,
    retry: false,
  });

  const trafficQuery = useQuery({
    queryKey: ["network-traffic", scope, range],
    queryFn: () =>
      (trafficPower as Extract<typeof trafficPower, { state: "ready" }>).use({
        scope: scope!,
        range: range!,
      }),
    enabled:
      trafficPower.state === "ready" &&
      scope !== undefined &&
      available &&
      range !== null,
    staleTime: 30_000,
    retry: false,
  });

  // A range that was asked for and refused is the unreachable state too —
  // the probe may have passed minutes ago and the server gone since.
  const broke = range !== null && query.error !== null;
  const status: RangedHistory["status"] =
    power.state === "unreachable" || broke
      ? "unreachable"
      : ready
        ? "ready"
        : "absent";

  return {
    status,
    enabled,
    // Offered only where a scope exists to ask about: a block that cannot be
    // upgraded must not advertise an upgrade.
    offerable: scope !== undefined && available,
    range,
    // Deselecting means "back to the live window", and there is not one to
    // go back to when nothing is running: it would empty the block rather
    // than reveal anything.
    select: live ? setRange : (next) => next !== null && setRange(next),
    loading: query.isFetching,
    window: range !== null && query.data ? query.data : null,
    traffic: range !== null ? (trafficQuery.data ?? null) : null,
    endpoint: power.state === "absent" ? "" : power.endpoint,
    vendor: power.state === "absent" ? "" : power.vendor,
    reason:
      power.state === "unreachable"
        ? power.reason
        : query.error
          ? normalizeTauriError(query.error)
          : "",
  };
}

/**
 * How full each volume is, where something can measure it.
 *
 * One instant query per namespace on the summary, and nothing at all where
 * no supplier is connected — the fallback sentence below is the answer in
 * that case and it costs no requests to say it.
 */
function useFullness(
  summary: ReturnType<typeof storageSummary>
): Map<string, VolumeFullness> {
  const power = useCapabilityState("volume.fullness");
  const namespace = summary?.claims[0]?.namespace ?? null;
  const claims = React.useMemo(
    () =>
      (summary?.claims ?? [])
        .filter((claim) => claim.namespace === namespace)
        .map((claim) => claim.name)
        .sort(),
    [summary, namespace]
  );

  const { data } = useQuery({
    queryKey: ["volume-fullness", namespace, claims],
    queryFn: () =>
      (power as Extract<typeof power, { state: "ready" }>).use({
        namespace: namespace!,
        claims,
      }),
    enabled: power.state === "ready" && namespace !== null && claims.length > 0,
    staleTime: 60_000,
    retry: false,
  });

  return React.useMemo(
    () => new Map((data ?? []).map((entry) => [entry.claim, entry])),
    [data]
  );
}

function StorageRow({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof storageSummary>>;
}) {
  const { claims, declared, unbound } = summary;
  const fullness = useFullness(summary);
  // The fallback sentence is not replaced wholesale: a cluster where the
  // kubelet reports some volumes and not others still owes the reader the
  // reason the quiet ones are quiet.
  const measured = claims.filter((claim) => fullness.has(claim.name)).length;
  return (
    <div className="mt-1 border-t border-hair pt-2">
      <div className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-3 px-1.5">
        <span className="text-[11px] text-fg-mut">Storage</span>
        <span className="text-[11px] text-fg-mut">
          {claims.length} volume{claims.length === 1 ? "" : "s"}
          {declared && (
            <>
              {" · "}
              <span className="font-mono tabular-nums text-fg-mid">
                {declared}
              </span>{" "}
              declared
            </>
          )}
          {unbound > 0 && (
            <span className="text-warn"> · {unbound} not bound</span>
          )}
        </span>
      </div>
      <ul className="mt-1">
        {claims.map((claim) => (
          <li
            key={`${claim.namespace ?? ""}/${claim.name}`}
            className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 px-1.5 py-0.5"
          >
            <span />
            <span className="text-[11px] text-fg-fnt">
              <span className="text-fg-mid">{claim.name}</span>
              {[claim.capacity, claim.storageClass, claim.phase, ...claim.paths]
                .filter(Boolean)
                .map((part) => ` · ${part}`)
                .join("")}
              <Fullness measured={fullness.get(claim.name)} />
            </span>
          </li>
        ))}
      </ul>
      {/* The half of the disk question this app cannot answer on its own,
       *  said once rather than implied by an empty bar nobody can fill —
       *  and still said for the volumes nothing measured, because "no
       *  kubelet scraping" and "an unprovisioned volume" look identical
       *  from here and an empty bar would read as 0% for both. */}
      {measured < claims.length && (
        <p className="px-1.5 pt-1 text-[11px] leading-snug text-fg-fnt">
          {measured === 0
            ? "Declared size, not how full. metrics-server reports CPU and memory only — how much of a volume is in use comes from the kubelet, which a Prometheus can read and this app cannot."
            : `Declared size, not how full, for the ${claims.length - measured} of these the kubelet does not report on.`}
        </p>
      )}
    </div>
  );
}

/**
 * Used against capacity, in the kubelet's own two numbers.
 *
 * Never a bare percentage: the capacity a kubelet reports is the filesystem
 * behind the volume, and for a provisioner that enforces no quota — a
 * `local-path` or a `hostPath` — that filesystem is the node's disk rather
 * than the claim's declared size. Printing both makes the difference from
 * the declared size beside it visible instead of confusing.
 */
function Fullness({ measured }: { measured?: VolumeFullness }) {
  if (!measured) return null;
  const share = Math.round((measured.usedBytes / measured.capacityBytes) * 100);
  const tone =
    share > 90 ? "text-err" : share > 75 ? "text-warn" : "text-fg-mut";
  return (
    <>
      {" · "}
      <span className={tone}>
        {formatQuantity(measured.usedBytes, "memory")} used of{" "}
        {formatQuantity(measured.capacityBytes, "memory")} · {share}%
      </span>
    </>
  );
}
