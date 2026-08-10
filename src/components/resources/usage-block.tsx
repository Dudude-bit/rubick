/**
 * The Usage block, on every page that has one.
 *
 * Everything a detail page needs to say about resource consumption lives
 * here so the answer cannot drift between kinds — a chart on the Pod page
 * and a bar on the Deployment page would be worse than bars on both.
 */
import * as React from "react";
import { Section, SectionHeader } from "@/components/ui/section";
import { UsageRow } from "@/components/resources/detail-blocks";
import {
  NO_LIMIT_NOTE,
  UsageChart,
  WATCHING_NOTE,
} from "@/components/resources/usage-chart";
import { useUsageHistory } from "@/hooks/useUsageHistory";
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
    enabled: available,
  });

  const storage = React.useMemo(
    () => storageSummary(connections),
    [connections]
  );

  // The span between the first and last readings, so the caption cannot
  // keep counting up while the metrics query is failing.
  const watched = samples.length > 0 ? watchedFor(samples) : null;

  // Both bands read the same buffer, so "watching from now" and "no limit
  // set" are facts about the workload rather than about CPU and then again
  // about memory. Said once, under the pair.
  const shared =
    available && samples.length > 0 && samples.length < 2
      ? WATCHING_NOTE
      : available && samples.length >= 2 && neither
        ? noLimitNote
        : null;

  const caption = !available
    ? // The block cannot promise a comparison the workload does not
      // declare — that pairing is what made an empty track read as 0%.
      neither
      ? `no ${limitNoun}s declared`
      : `against declared ${limitNoun}s`
    : [
        scope,
        watched === null
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
        actions={available ? <RangePicker /> : undefined}
      />
      <div>
        {available ? (
          <>
            <UsageChart
              label="CPU"
              type="cpu"
              samples={samples}
              limit={cpuLimit}
              limitNoun={limitNoun}
              noLimitNote={neither ? null : noLimitNote}
              current={cpu ?? null}
              suppressNote={shared !== null}
            />
            <UsageChart
              label="Memory"
              type="memory"
              samples={samples}
              limit={memoryLimit}
              limitNoun={limitNoun}
              noLimitNote={neither ? null : noLimitNote}
              current={memory ?? null}
              suppressNote={shared !== null}
            />
            {shared && (
              <p className="pb-1 pl-[104px] pr-1.5 text-[11px] leading-snug text-fg-fnt">
                {shared}
              </p>
            )}
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

const RANGES = ["1h", "6h", "24h"] as const;

/**
 * Dimmed and inert, on purpose.
 *
 * These ranges are answerable only by something with a past, and
 * metrics.k8s.io has none. Drawing them disabled says "this needs
 * something you have not connected" in a way an absent control cannot,
 * and `disabled` rather than a styled span means assistive tech is told
 * the same thing the dimming says.
 */
function RangePicker() {
  return (
    <span className="flex gap-0.5">
      {RANGES.map((range) => (
        <button
          key={range}
          type="button"
          disabled
          title="Needs a Prometheus — metrics-server keeps no history to range over"
          className="cursor-default rounded px-1.5 py-0.5 text-[11px] text-fg-mut opacity-40"
        >
          {range}
        </button>
      ))}
    </span>
  );
}

function StorageRow({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof storageSummary>>;
}) {
  const { claims, declared, unbound } = summary;
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
            </span>
          </li>
        ))}
      </ul>
      {/* The half of the disk question this app cannot answer, said once
       *  rather than implied by an empty bar nobody can fill. */}
      <p className="px-1.5 pt-1 text-[11px] leading-snug text-fg-fnt">
        Declared size, not how full. metrics-server reports CPU and memory only
        — how much of a volume is in use comes from the kubelet Summary API,
        which this app does not read.
      </p>
    </div>
  );
}
