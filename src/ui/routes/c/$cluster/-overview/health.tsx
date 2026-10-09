import { Fragment } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CircleSlash, Loader2, Lock, TriangleAlert } from "lucide-react";

import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Composition } from "@/components/object/detail-blocks";
import { Prose, ResourceMessage } from "@/components/object/ResourceMessage";
import { ResourceRef } from "@/components/object/ResourceRef";
import { KindIcon } from "@/components/object/KindIcon";
import { useShareSection } from "@/components/share/screen-share";
import {
  composedDetail,
  detailWords,
  cpuRatio,
  memoryRatio,
  nodesShare,
  podSegments,
  podTotal,
  PRESSURE_WARN,
  attentionShare,
  schedulerShare,
  warningsShare,
  workloadCards,
  workloadsShare,
  type Ratio,
} from "./health-share";
import { eventReasonMark } from "@/lib/event-reason";
import {
  attentionLines,
  checkRefused,
  foldedWords,
  reasonWord,
  unreadWhere,
  type Attention,
  type AttentionLine,
  type AttentionCheck,
  type AttentionItem,
} from "@/lib/attention";
import { parseRefusal } from "@/lib/refusal";
import { ERROR_CODES } from "@/lib/error-utils";
import { listLink, objectLink } from "@/lib/links";
import {
  ROLE_DOT,
  ROLE_ICON,
  ROLE_TEXT,
  type StatusRole,
} from "@/lib/status-role";
import { cn, formatAge } from "@/lib/utils";
import { getDisplayPlural, ResourceType } from "@/lib/resource-registry";
import type {
  Census,
  ClusterOverview,
  NodeSummary,
  OverviewUnread,
  PodComposition,
  ResourcePressure,
  SchedulerPressure,
  WarningGroup,
} from "@/generated/types";
import { useT, type T } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { formatCount } from "@/lib/count";
import { allocatedPercent } from "@/lib/node-amount";
import { useAttentionExpanded } from "./attention-expanded";

/**
 * The unit rides along dimmed and a size smaller, so the number keeps the
 * eye in a column of otherwise identical-looking quantities.
 */
function Unit({ children }: { children: React.ReactNode }) {
  return <span className="text-[0.85em] text-fg-fnt">{children}</span>;
}

// One grid for every row, so a column is as wide as what its rows hold: the
// reason up to Init:CreateContainerConfigError, a count or an age only where
// a row has one, and the sentence the rest.
const ROWS =
  "@container grid grid-cols-[auto_fit-content(240px)_minmax(12rem,1fr)_auto_auto_auto] gap-x-2.5";
// Baselines, not centres: a detail that wraps keeps the marks on its first line.
const ROW =
  "col-span-full grid grid-cols-subgrid items-baseline rounded-[5px] px-1.5 py-[5px] text-xs";
const MARK = "mt-0.5 h-3 w-3 self-start justify-self-center";
const SAID = "line-clamp-4 min-w-0 wrap-break-word text-fg-mid";

/**
 * A 60x14 trend line for one problem row.
 *
 * There is no history behind this: the backend returns a snapshot, so the
 * only shape the data justifies is "a pod that has already restarted is still
 * climbing", and everything else draws flat. Derived from the row beside it,
 * not telemetry — do not read it as a series, and do not add shapes no field
 * in `ClusterProblem` supports.
 */
function Sparkline({
  rising,
  className,
}: {
  rising: boolean;
  className: string;
}) {
  return (
    <svg
      width="60"
      height="14"
      viewBox="0 0 60 14"
      className={cn("block", className)}
      aria-hidden="true"
    >
      <polyline
        points={
          rising
            ? "0,12 10,12 20,10 30,8 40,5 50,3 60,1"
            : "0,7 10,7 20,7 30,7 40,7 50,7 60,7"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const VISIBLE = 12;

function AttentionDetailText({ item }: { item: AttentionItem }) {
  const t = useT();
  const { detail } = item;
  if (!detail) return null;
  if (detail.says === "said")
    return (
      <ResourceMessage
        message={detail.text}
        subject={{
          kind: item.kind,
          name: item.name,
          namespace: item.namespace,
        }}
      />
    );
  return (
    <Prose
      text={detail.says === "ours" ? detail.text : composedDetail(detail, t)}
    />
  );
}

/** The class an Ingress under the missing-class line lacks, in place of the line's sentence. */
function ClassMarker({ name }: { name: string }) {
  const t = useT();
  return (
    <span
      role="img"
      aria-label={t("empty", "noIngressClassNamed", { name })}
      className="inline-flex min-w-0 items-center gap-1 pl-3 font-mono text-err"
    >
      <CircleSlash className="h-2.5 w-2.5 flex-none" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** One line for every Ingress asking for a class this cluster does not have. */
function UnservedRow({
  className,
  members,
}: {
  className: string;
  members: number;
}) {
  const t = useT();
  const SeverityIcon = ROLE_ICON.err;
  return (
    <div className={ROW} data-testid="attention-unserved">
      <SeverityIcon className={cn(MARK, ROLE_TEXT.err)} aria-hidden="true" />
      <span className="inline-flex min-w-0 items-baseline gap-1 font-mono font-medium text-err">
        <CircleSlash
          className="h-2.5 w-2.5 flex-none self-center"
          aria-hidden="true"
        />
        <span className="truncate">{t("readings", "healthNoController")}</span>
      </span>
      <span className={SAID} title={t("empty", "nothingPickedThemUp")}>
        {t("count", "ingressesUnserved", { n: members, classes: className })}
      </span>
      <span />
      <span />
      <span />
    </div>
  );
}

function AttentionRow({
  item,
  grouped = false,
}: {
  item: AttentionItem;
  grouped?: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const tone = ROLE_TEXT[item.tone];
  const SeverityIcon = ROLE_ICON[item.tone];
  const link = objectLink(item.opens);
  const restarts = item.restarts ?? 0;
  const { Icon: ReasonIcon } = eventReasonMark(item.reason);
  const elsewhere =
    item.opens.kind !== item.kind || item.opens.name !== item.name;
  const marked = grouped ? item.unservedClass : undefined;
  const detail: AttentionItem["detail"] = !marked
    ? item.detail
    : marked.rest
      ? { says: "ours", text: marked.rest }
      : null;

  const body = (
    <>
      {/* Shape carries the severity alongside the colour: a red/green
       *  deficiency must not flatten the only ranking on this screen. */}
      <SeverityIcon className={cn(MARK, tone)} aria-hidden="true" />
      {marked ? (
        <ClassMarker name={marked.name} />
      ) : (
        <span
          className={cn(
            "inline-flex min-w-0 items-baseline gap-1 font-mono font-medium",
            tone
          )}
        >
          <ReasonIcon
            className="h-2.5 w-2.5 flex-none self-center"
            aria-hidden="true"
          />
          <span className="truncate" title={reasonWord(item, t)}>
            {reasonWord(item, t)}
          </span>
        </span>
      )}
      <span className={SAID} data-testid="attention-said">
        <ResourceRef
          kind={item.kind}
          name={item.name}
          namespace={item.namespace}
          showKind={false}
          className="max-w-full"
        />
        {elsewhere && (
          <>
            <span className="text-fg-fnt">{" → "}</span>
            <ResourceRef
              kind={item.opens.kind}
              name={item.opens.name}
              namespace={item.opens.namespace}
              showKind={false}
              className="max-w-full"
            />
          </>
        )}
        {item.namespace && (
          <span className="whitespace-nowrap text-fg-fnt">
            {" "}
            · {item.namespace}
          </span>
        )}
        {item.foldedPods !== null && (
          <span className="text-fg-mut"> · {foldedWords(item, t)}</span>
        )}
        {detail && (
          // The row cuts a long sentence; hovering it has the whole one.
          <span
            className="text-fg-fnt"
            title={detailWords(detail, t) ?? undefined}
          >
            {": "}
            <AttentionDetailText item={{ ...item, detail }} />
          </span>
        )}
      </span>
      {/* The first to give way: it draws nothing the row does not already say. */}
      <span className="self-start" data-testid="attention-trend">
        <Sparkline
          rising={item.kind === "Pod" && restarts > 0}
          className={cn("mt-px @max-[56rem]:hidden", tone)}
        />
      </span>
      <span className="whitespace-nowrap text-right font-mono text-fg-mut">
        {restarts > 0 && (
          <>
            {restarts}
            <Unit> {t("count", "restartNoun", { n: restarts })}</Unit>
          </>
        )}
      </span>
      <span className="whitespace-nowrap text-right text-[11px] leading-4 text-fg-fnt">
        {item.since !== null && formatAge(item.since, t)}
      </span>
    </>
  );

  if (link === null) return <div className={ROW}>{body}</div>;
  // The row opens the object's page; the name inside it opens the peek.
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        navigate(link);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        navigate(link);
      }}
      className={cn(ROW, "cursor-pointer hover:bg-hover")}
    >
      {body}
    </div>
  );
}

const TOGGLE =
  "rounded text-fg-mut underline decoration-hair underline-offset-2 transition-colors hover:text-fg focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info";

/**
 * The rows past the cap, by kind, each a way into its list. The count opens
 * the rows this list holds in place; what the backend cut has only a count.
 */
function MoreRows({
  hidden,
  cut,
  onExpand,
  onCollapse,
}: {
  hidden: AttentionItem[];
  cut: number;
  onExpand: () => void;
  /** Present once the rows past the cap are open. */
  onCollapse?: () => void;
}) {
  const t = useT();
  const byKind = new Map<string, number>();
  for (const item of hidden)
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  const more = t("cluster", "attentionMore", { n: hidden.length + cut });
  return (
    <p className="col-span-full flex flex-wrap items-baseline gap-x-2 px-1.5 py-[5px] text-[11px] text-fg-fnt">
      {onCollapse && (
        <button
          type="button"
          aria-expanded={true}
          onClick={onCollapse}
          className={TOGGLE}
        >
          {t("action", "showFewer")}
        </button>
      )}
      {hidden.length + cut === 0 ? null : hidden.length > 0 ? (
        <button
          type="button"
          aria-expanded={false}
          onClick={onExpand}
          className={TOGGLE}
        >
          {more}
        </button>
      ) : (
        <span>{more}</span>
      )}
      {[...byKind].map(([kind, n]) => (
        <Link
          key={kind}
          {...listLink(kind)}
          className="inline-flex items-center gap-1 text-fg-mut hover:text-fg"
        >
          <KindIcon kind={kind} className="h-2.5 w-2.5" />
          <span className="font-mono">
            {n} {n === 1 ? kind : getDisplayPlural(kind)}
          </span>
        </Link>
      ))}
    </p>
  );
}

/** One kind the list could not look at: refused, failed, or not answered yet. */
function CheckRow({ check }: { check: AttentionCheck }) {
  const t = useT();
  const reading = check.state === "reading";
  const refused = checkRefused(check);
  const Icon = reading ? Loader2 : refused ? Lock : TriangleAlert;
  const said = check.unread.find((entry) => entry.message)?.message ?? null;
  const named = check.unread.some((entry) => entry.namespace);
  // A refusal reads as what was refused and where; the server's sentence is
  // on hover, where kubectl's words can be checked against it.
  const verb = refused && said ? parseRefusal(said)?.verb : undefined;
  return (
    <li className="col-span-full grid grid-cols-subgrid items-baseline py-[3px] text-xs">
      <Icon
        className={cn(
          MARK,
          reading
            ? "animate-spin text-info"
            : refused
              ? "text-fg-mut"
              : "text-warn"
        )}
        aria-hidden="true"
      />
      <span className="inline-flex items-baseline gap-1 whitespace-nowrap font-mono text-fg-mid">
        <KindIcon
          kind={check.kind}
          className="h-2.5 w-2.5 flex-none self-center"
        />
        {getDisplayPlural(check.kind)}
      </span>
      <span
        className="min-w-0 wrap-break-word text-fg-mut"
        title={said ?? undefined}
      >
        {reading
          ? t("cluster", "attentionStillReading")
          : refused
            ? verb
              ? parts(t("cluster", "attentionForbidden"), {
                  verb: <span className="font-mono text-fg-mid">{verb}</span>,
                })
              : t("cluster", "attentionRefused")
            : t("cluster", "attentionFailed")}
        {(named || refused) && (
          <span className="text-fg-fnt">
            {" "}
            <Prose text={unreadWhere(check.unread, t)} />
          </span>
        )}
        {said && !refused && (
          <span className="font-mono text-[11px] text-fg-fnt">
            {": "}
            {said}
          </span>
        )}
      </span>
    </li>
  );
}

/** The word beside the summary dot: no verdict of its own while rows above it carry one. */
const SUMMARY_LABEL: Record<
  StatusRole,
  "healthy" | "attentionPartly" | "attentionOverall"
> = {
  ok: "healthy",
  neutral: "attentionPartly",
  pending: "attentionOverall",
  warn: "attentionOverall",
  err: "attentionOverall",
};

/** The first rows, never ending on a missing-class line with none of its Ingresses under it. */
function capped(lines: AttentionLine[]): AttentionLine[] {
  const head = lines.slice(0, VISIBLE);
  return head.at(-1)?.at === "unserved" ? head.slice(0, -1) : head;
}

/** Not-running pods by phase, in the words the composition bar uses, one count and its words each. */
function notRunning(pods: PodComposition, t: T): string[] {
  return podSegments(pods, t)
    .filter((segment) => segment.label !== "Running" && segment.count > 0)
    .map((segment) =>
      [`${segment.count} ${segment.label}`, segment.qualifier]
        .filter(Boolean)
        .join(" · ")
    );
}

export function AttentionPanel({
  attention,
  pods,
  podsUnread,
  nodes,
  nodesKnown,
}: {
  attention: Attention;
  /** `null` when no pod list in scope answered: no count to state. */
  pods: Census<PodComposition> | null;
  /** Where the pods went unread, said beside whatever was counted. */
  podsUnread: readonly OverviewUnread[];
  nodes: NodeSummary[];
  /** False when the node list was refused: the "N nodes ready" half of the
   *  summary is unknown, not "0 of 0", so it is left off. */
  nodesKnown: boolean;
}) {
  const t = useT();
  useShareSection("overview-problems", () => attentionShare(attention, t));
  const { items, total, complete, worst } = attention;
  const expanded = useAttentionExpanded((state) => state.expanded);
  const setExpanded = useAttentionExpanded((state) => state.setExpanded);
  const lines = attentionLines(items);
  const head = capped(lines);
  const shown = expanded ? lines : head;
  const hidden = lines
    .slice(shown.length)
    .flatMap((line) => (line.at === "item" ? [line.item] : []));
  const cut = total - items.length;
  const unchecked = attention.checks.filter((check) => check.state !== "read");
  const readyNodes = nodes.filter((n) => n.ready).length;
  const down = pods ? notRunning(pods.read, t) : [];
  const nodesLine =
    nodesKnown &&
    t("count", "nodesReady", {
      n: readyNodes,
      of: t("count", "ofNodes", { n: nodes.length }),
    });
  const summaryRole: StatusRole = worst ?? (complete ? "ok" : "neutral");

  return (
    <Section>
      <SectionHeader
        title={t("action", "needsAttention")}
        count={
          total > 0
            ? t("count", complete ? "worstFirst" : "worstFirstPartial", {
                n: formatCount(total),
              })
            : complete
              ? t("cluster", "attentionNothing")
              : t("cluster", "attentionNoneFound")
        }
      />
      <div className={ROWS}>
        {shown.map((line) =>
          line.at === "item" ? (
            <AttentionRow
              key={line.item.key}
              item={line.item}
              grouped={line.grouped}
            />
          ) : (
            <UnservedRow
              key={`unserved/${line.className}`}
              className={line.className}
              members={line.members}
            />
          )
        )}
        {(hidden.length + cut > 0 || head.length < shown.length) && (
          <MoreRows
            hidden={hidden}
            cut={cut}
            onExpand={() => setExpanded(true)}
            onCollapse={
              head.length < shown.length ? () => setExpanded(false) : undefined
            }
          />
        )}
        {/* What is fine gets one muted line after the rows, never a panel of
         *  green checkmarks competing with them. Its dot is the list's
         *  verdict: green only when everything named was read clean. */}
        <div className={cn(ROW, "items-start")} data-testid="attention-summary">
          <span
            className={cn(
              "mt-[4.5px] h-[7px] w-[7px] justify-self-center rounded-full",
              ROLE_DOT[summaryRole]
            )}
            aria-hidden="true"
          />
          <span className="truncate font-mono font-medium text-fg-mut">
            {t("cluster", SUMMARY_LABEL[summaryRole])}
          </span>
          {/* Every count stays whole with its words, and the line breaks
              between them; the words that change what the counts mean come
              after and are never cut either. */}
          <span
            className="col-span-4 min-w-0 text-fg-fnt"
            data-testid="attention-overall"
          >
            {pods && (
              <span className="whitespace-nowrap">
                {t("count", "podsReady", {
                  n: formatCount(pods.read.ready),
                  of: t("count", "ofPods", { n: podTotal(pods.read) }),
                })}
              </span>
            )}
            {down.length > 0 && (
              <span data-testid="attention-overall-details">
                {down.map((segment, index) => (
                  <Fragment key={index}>
                    {" "}
                    <span className="whitespace-nowrap">
                      {index === 0 && "("}
                      {segment}
                      {index === down.length - 1 ? ")" : ","}
                    </span>
                  </Fragment>
                ))}
              </span>
            )}
            {nodesLine && (
              <>
                {pods && " "}
                <span className="whitespace-nowrap">
                  {pods && "·\u00a0"}
                  {nodesLine}
                </span>
              </>
            )}
            {(!pods || podsUnread.length > 0) && (
              <>
                {(pods || nodesLine) && " "}
                <UnreadMark unread={podsUnread}>
                  <Prose
                    text={t("cluster", "podsNotCounted", {
                      where: unreadWhere(podsUnread, t),
                    })}
                  />
                </UnreadMark>
              </>
            )}
          </span>
        </div>
        {unchecked.length > 0 && (
          <div
            className="col-span-full mt-1 border-t border-hair pt-1.5"
            data-testid="attention-unchecked"
          >
            <p className="px-1.5 pb-0.5 text-[11px] text-fg-fnt">
              {t("cluster", "attentionNotChecked")}
            </p>
            <ul className="grid grid-cols-[10px_max-content_minmax(0,1fr)] gap-x-2.5 px-1.5">
              {unchecked.map((check) => (
                <CheckRow key={check.kind} check={check} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

/** The panel while this scope's own answer is on its way: the last scope's would be the wrong list. */
export function AttentionPending() {
  const t = useT();
  return (
    <Section>
      <SectionHeader title={t("action", "needsAttention")} />
      <p className="flex items-center gap-2 px-1.5 py-[5px] text-xs text-fg-mut">
        <Loader2
          className="h-3 w-3 animate-spin text-info"
          aria-hidden="true"
        />
        {t("cluster", "attentionStillReading")}
      </p>
    </Section>
  );
}

/** Words about where a kind went unread, behind the mark of why: refused or failed. */
function UnreadMark({
  unread,
  children,
}: {
  unread: readonly OverviewUnread[];
  children: React.ReactNode;
}) {
  const refused = unread.every(
    (entry) => entry.code === ERROR_CODES.PERMISSION
  );
  const Icon = refused ? Lock : TriangleAlert;
  return (
    <span title={unread.find((entry) => entry.message)?.message}>
      <Icon
        className={cn(
          "mr-1 inline-block h-2.5 w-2.5 align-[-1px]",
          refused ? "text-fg-mut" : "text-warn"
        )}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

/** Composition of what this scope is made of. */
export function WorkloadsPanel({
  overview,
  scope,
}: {
  overview: ClusterOverview;
  scope: string;
}) {
  const t = useT();
  const { problemsTruncated } = overview;
  useShareSection("overview-workloads", () => workloadsShare(overview, t));

  return (
    <Section>
      <SectionHeader
        title={t("nav", "workloads")}
        count={
          problemsTruncated > 0
            ? `${scope} · +${t("count", "unrankedProblems", {
                n: problemsTruncated,
              })}`
            : scope
        }
      />
      <div className="grid grid-cols-4 gap-[22px]">
        {workloadCards(overview, t).map((card) => {
          const partial = card.total !== null && card.unread.length > 0;
          return (
            <Composition
              key={card.kind}
              total={card.total}
              label={card.total === 1 ? card.kind : getDisplayPlural(card.kind)}
              emptyMessage={t(
                "empty",
                partial ? "noneWhereRead" : "noneInScope"
              )}
              segments={card.segments}
              note={
                card.unread.length > 0 ? (
                  <UnreadMark unread={card.unread}>
                    {partial ? (
                      parts(t("cluster", "notReadWhere"), {
                        where: (
                          <span className="inline-block max-w-full">
                            {unreadWhere(card.unread, t)}
                          </span>
                        ),
                      })
                    ) : (
                      <Prose text={unreadWhere(card.unread, t)} />
                    )}
                  </UnreadMark>
                ) : undefined
              }
            />
          );
        })}
      </div>
    </Section>
  );
}

function PressureRow({
  label,
  pressure,
  ratio: format,
}: {
  label: string;
  pressure: ResourcePressure;
  ratio: (pressure: ResourcePressure) => Ratio;
}) {
  const share =
    pressure.allocatable > 0 ? pressure.requested / pressure.allocatable : 0;
  const usedShare =
    pressure.allocatable > 0 && pressure.usage != null
      ? pressure.usage / pressure.allocatable
      : null;
  const tight = share >= PRESSURE_WARN;
  const { used, total, unit } = format(pressure);

  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)_150px] items-center gap-3 px-1.5 py-1">
      <span className="text-[11px] text-fg-mut">{label}</span>
      <span className="relative h-[5px] overflow-hidden rounded-[3px] bg-sel">
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-[3px]",
            tight ? "bg-warn" : "bg-info"
          )}
          style={{ width: `${Math.min(100, share * 100)}%` }}
        />
        {/* Live usage is a tick, not a second bar: it is context for the
         *  reserved number, not a competing metric. */}
        {usedShare != null && (
          <span
            className="absolute inset-y-0 w-0.5 bg-fg-mid"
            style={{ left: `${Math.min(100, usedShare * 100)}%` }}
          />
        )}
      </span>
      <span className="text-right font-mono text-[11px] text-fg-mut">
        {used}
        <Unit>/</Unit>
        {total}
        <Unit>{unit}</Unit> ·{" "}
        {allocatedPercent(pressure.requested, pressure.allocatable) ?? 0}
        <Unit>%</Unit>
      </span>
    </div>
  );
}

export function SchedulerPanel({
  scheduler,
  metricsAvailable,
}: {
  scheduler: SchedulerPressure;
  metricsAvailable: boolean;
}) {
  const t = useT();
  useShareSection("overview-scheduler", () => schedulerShare(scheduler, t));
  return (
    <Section>
      {/* Naming the denominator matters: people read a low bar as "room to
       *  spare" and then wonder why the next pod sits Pending. */}
      <SectionHeader
        title={t("cluster", "schedulerHeadroom")}
        count={
          metricsAvailable
            ? t("cluster", "headroomLegend")
            : t("cluster", "headroomLegendNoMetrics")
        }
      />
      <div>
        <PressureRow label="CPU" pressure={scheduler.cpu} ratio={cpuRatio} />
        <PressureRow
          label={t("columns", "memory")}
          pressure={scheduler.memory}
          ratio={memoryRatio}
        />
      </div>
    </Section>
  );
}

function NodeRow({ node }: { node: NodeSummary }) {
  const t = useT();
  const navigate = useNavigate();
  const open = () =>
    navigate(objectLink({ kind: ResourceType.Node, name: node.name })!);
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a")) return;
        open();
      }}
      onKeyDown={(event) => event.key === "Enter" && open()}
      className="grid cursor-pointer grid-cols-[7px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[5px] px-1.5 py-[5px] text-xs hover:bg-hover"
    >
      <span
        className={cn(
          "h-[7px] w-[7px] rounded-full",
          node.ready ? "bg-ok" : "bg-err"
        )}
        aria-hidden="true"
      />
      <span className="flex min-w-0 items-baseline gap-2">
        <ResourceRef
          kind={ResourceType.Node}
          name={node.name}
          showKind={false}
        />
        {node.roles.map((role) => (
          <span key={role} className="text-[11px] text-fg-fnt">
            {role}
          </span>
        ))}
        {!node.schedulable && (
          <span className="text-[11px] text-warn">cordoned</span>
        )}
        {!node.ready && <span className="text-[11px] text-err">NotReady</span>}
      </span>
      <span className="text-right font-mono text-[11px] text-fg-mut">
        {node.podCount}
        {node.podCapacity != null && (
          <>
            <Unit>/</Unit>
            {node.podCapacity}
          </>
        )}
        <Unit>
          {" "}
          {t("count", "podNoun", { n: node.podCapacity ?? node.podCount })}
        </Unit>
      </span>
    </div>
  );
}

export function NodesPanel({
  nodes,
  version,
}: {
  nodes: NodeSummary[];
  /** Server version, shown here rather than in a page title of its own. */
  version?: string;
}) {
  const t = useT();
  useShareSection("overview-nodes", () => nodesShare(nodes, version, t));
  // Rendered in full, unlike the problems list: node counts are bounded in
  // practice, and a "+N more" would hide the node someone opened this panel
  // to find.
  return (
    <Section>
      <SectionHeader
        title="Nodes"
        count={
          version ? `${nodes.length} · Kubernetes ${version}` : nodes.length
        }
      />
      <div>
        {nodes.map((node) => (
          <NodeRow key={node.name} node={node} />
        ))}
      </div>
    </Section>
  );
}

export function WarningsPanel({
  warnings,
  known,
}: {
  warnings: WarningGroup[];
  /** False when an events list failed or was cut short: the rows are
   *  then only part. */
  known: boolean;
}) {
  const t = useT();
  useShareSection("overview-warnings", () => warningsShare(warnings, known, t));
  if (known && warnings.length === 0) return null;

  return (
    <Section>
      <SectionHeader
        title={t("cluster", "warningEvents")}
        count={t("cluster", "warningEventsScope")}
      />
      {!known && (
        <p className="py-1 text-xs text-fg-mut">
          {t("cluster", "warningEventsUnread")}
        </p>
      )}
      {warnings.length > 0 && (
        <SectionBody>
          {warnings.map((warning) => (
            <WarningRow key={warning.reason} warning={warning} />
          ))}
        </SectionBody>
      )}
    </Section>
  );
}

function WarningRow({ warning }: { warning: WarningGroup }) {
  const t = useT();
  // Every row here is a Warning, so severity owns the colour outright and the
  // family mark contributes only shape.
  const { Icon } = eventReasonMark(warning.reason);
  // `showKind` stays on: nothing beside this name says the kind.
  const subject =
    warning.objectKind && warning.objectName
      ? {
          kind: warning.objectKind,
          name: warning.objectName,
          namespace: warning.namespace,
        }
      : null;

  return (
    <div className="grid grid-cols-[260px_minmax(0,1fr)_46px] items-baseline gap-2.5 px-1.5 py-[5px] text-xs">
      {/* 260px holds FailedComputeMetricsReplicas and its count whole. */}
      <span className="inline-flex min-w-0 items-baseline gap-1 font-mono font-medium text-warn">
        <Icon
          className="h-2.5 w-2.5 flex-none self-center"
          aria-hidden="true"
        />
        <span className="truncate" title={warning.reason}>
          {warning.reason}
        </span>
        {warning.count > 1 && (
          <span className="flex-none">
            <Unit>×{warning.count}</Unit>
          </span>
        )}
      </span>
      <span
        className={SAID}
        title={warning.sample ?? undefined}
        data-testid="warning-said"
      >
        {subject && (
          <ResourceRef
            kind={subject.kind}
            name={subject.name}
            namespace={subject.namespace}
            className="max-w-full"
          />
        )}
        {subject && warning.sample && " "}
        {warning.sample && (
          <span className="text-fg-fnt">
            {/* Names in the message are resolved against `subject`; a group
             *  carrying only a `"Kind/name"` string and no namespace leaves
             *  them nothing to resolve against. */}
            <ResourceMessage
              message={warning.sample}
              subject={subject ?? undefined}
            />
          </span>
        )}
      </span>
      <span className="text-right text-[11px] text-fg-fnt">
        {formatAge(warning.lastSeen, t)}
      </span>
    </div>
  );
}
