import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  ExternalLink,
  HelpCircle,
  Search,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { ObjectLink } from "@/components/resources/ResourceRef";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useT, type T } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { cn, formatSince } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { crdObjectPath } from "../../kit";
import { OutLink } from "../../page-kit";
import type { Picture } from "./data";
import { useHeartbeat, STEP } from "./heartbeat";
import { Strip } from "./Strip";
import { useNow } from "@/hooks/useNow";
import {
  POD_MONITORS_CRD,
  PROMETHEUSES_CRD,
  SERVICE_MONITORS_CRD,
  downSince,
  hintFor,
  poolPrefix,
  readPrometheus,
  selectorIsEmpty,
  selectorWords,
  type Hint,
  type MonitorRow,
  type PrometheusInstance,
} from "./model";
import { rowTone, rowWords, type RowTone } from "./words";

const TONE_TEXT: Record<RowTone, string> = {
  err: "text-err",
  warn: "text-warn",
  ok: "text-ok",
  none: "text-err",
  mut: "text-fg-fnt",
};

const CARD: Record<RowTone, string> = {
  err: "border-err/45 bg-err/7",
  warn: "border-warn/45 bg-warn/7",
  ok: "border-ok/40 bg-ok/6",
  none: "border-err/45 bg-err/7",
  mut: "border-dashed border-hair bg-hover",
};

const ICON: Record<RowTone, typeof X> = {
  err: X,
  warn: Clock,
  ok: Check,
  none: AlertTriangle,
  mut: HelpCircle,
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function Detail({
  row,
  picture,
}: {
  row: MonitorRow;
  picture: Picture;
}) {
  const t = useT();
  const context = useClusterStore((state) => state.currentContext);
  const copy = useCopyToClipboard();
  const { monitor, scrape } = row;
  const tone = rowTone(row);
  const now = useNow();
  const beat = useHeartbeat(row);
  const since =
    beat.lanes !== null && beat.window !== null
      ? downSince(beat.lanes, beat.window.from, STEP)
      : null;
  const saved = useQuery({
    queryKey: [context, "prometheus", "page-address"],
    queryFn: () => commands.getPrometheusConnection(),
    staleTime: 60_000,
  });
  const base = saved.data?.url.replace(/\/+$/, "") ?? null;
  const crd =
    monitor.kind === "ServiceMonitor" ? SERVICE_MONITORS_CRD : POD_MONITORS_CRD;
  const instances =
    picture.prometheuses.state === "read"
      ? picture.prometheuses.items.map(readPrometheus)
      : [];
  const hint = hintFor(row);
  const lastScrapeAgo =
    scrape.state === "read" && scrape.lastScrape
      ? formatSince(Date.parse(scrape.lastScrape), now)
      : null;

  const verdict = verdictOf(row, instances.length, since, lastScrapeAgo, t);
  const Icon = ICON[tone];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="break-all font-mono text-[15px] font-medium tracking-tight text-fg">
            {monitor.name}
          </span>
          <span className="text-[11.5px] text-fg-fnt">
            {monitor.kind} ·{" "}
            <span className="font-mono text-fg-mut">{monitor.namespace}</span>
          </span>
        </div>
        <div className="flex flex-none gap-1.5">
          <Link
            to={crdObjectPath(crd, monitor.namespace, monitor.name)}
            className="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-hair px-2.5 text-xs text-fg-mid hover:bg-hover"
          >
            {t("monitors", "openObject")}
          </Link>
          {base !== null && scrape.state === "read" && (
            <OutLink
              href={`${base}/targets?scrapePool=${encodeURIComponent(poolPrefix(monitor) + "0")}`}
              site="Prometheus"
              className="h-7 rounded-[5px] border border-hair px-2.5 text-xs text-fg-mid hover:bg-hover hover:no-underline"
            >
              {t("monitors", "targetsInPrometheus")}
            </OutLink>
          )}
        </div>
      </div>

      <div
        className={cn(
          "flex items-start gap-2.5 rounded-lg border px-3.5 py-3",
          CARD[tone]
        )}
      >
        <Icon
          className={cn("mt-0.5 size-4 flex-none", TONE_TEXT[tone])}
          aria-hidden
        />
        <div className="min-w-0">
          <p
            className={cn(
              "text-[13px] font-semibold leading-snug",
              tone === "mut" ? "text-fg" : TONE_TEXT[tone]
            )}
          >
            {verdict.head}
          </p>
          {verdict.body && (
            <p className="mt-1 text-xs leading-relaxed text-fg-mut">
              {verdict.body}
            </p>
          )}
        </div>
      </div>

      {beat.query !== null && (
        <HeartbeatPanel row={row} beat={beat} since={since} />
      )}

      <div className="flex flex-col">
        <Step
          tone={selectsTone(row)}
          title={t("monitors", "selects")}
          count={selectsCount(row, t)}
          last={false}
        >
          <Chips>
            {selectorWords(monitor.selector)
              .split(", ")
              .filter(Boolean)
              .map((pair) => (
                <Chip key={pair} label={t("monitors", "chipLabel")}>
                  {pair}
                </Chip>
              ))}
            {row.selected.kind === "services" &&
              row.selected.names.map((name) => {
                const [namespace, service] = name.split("/");
                return (
                  <Chip key={name}>
                    <ObjectLink
                      kind="Service"
                      name={service}
                      namespace={namespace}
                    >
                      {name}
                    </ObjectLink>
                  </Chip>
                );
              })}
            {row.selected.kind === "services" &&
              row.selected.names.length === 0 && (
                <Chip tone="err">
                  {t("monitors", "noServicesIn", {
                    namespace: monitor.namespace,
                  })}
                </Chip>
              )}
            {row.selected.kind === "notCounted" && (
              <Chip tone="mut">{t("monitors", "notCounted")}</Chip>
            )}
          </Chips>
          {row.selected.kind === "unread" && (
            <p className="mt-1 text-xs text-warn">
              {t("monitors", "selectionUnread", {
                reason: row.selected.reason,
              })}
            </p>
          )}
        </Step>

        <Step
          tone="ok"
          title={t("monitors", "endpoints")}
          count={String(monitor.endpoints.length)}
          last={false}
        >
          <Chips>
            {monitor.endpoints.map((endpoint, index) => (
              <Chip key={index} label={t("monitors", "chipPort")}>
                {endpoint.port ?? "?"}
                <Sub>{t("monitors", "chipPath")}</Sub>
                {endpoint.path}
                {endpoint.interval && (
                  <>
                    <Sub>{t("monitors", "chipEvery")}</Sub>
                    {endpoint.interval}
                  </>
                )}
              </Chip>
            ))}
          </Chips>
        </Step>

        <PickedUpStep row={row} instances={instances} t={t} />

        <TargetsStep row={row} now={now} t={t} />
      </div>

      {hint !== null && (
        <div className="rounded-lg border border-info/35 bg-info/6 px-3.5 py-3">
          <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.07em] text-info">
            <Zap className="size-3" aria-hidden />
            {t("monitors", "mostLikely")}
          </p>
          <p className="text-[12.5px] leading-relaxed text-fg">
            {hintWhy(hint, t)}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-fg-mut">
            {hintHow(hint, t)}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() =>
                copy(agentNote(row, hint, t), t("monitors", "copiedForAgent"))
              }
              className="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-hair px-2.5 text-xs text-fg-mid hover:bg-hover"
            >
              <Copy className="size-3" aria-hidden />
              {t("monitors", "copyForAgent")}
            </button>
            {scrape.state === "read" && scrape.lastError && (
              <OutLink
                href={`https://www.google.com/search?q=${encodeURIComponent(`prometheus "${scrape.lastError}"`)}`}
                site="Google"
                className="h-7 rounded-[5px] border border-hair px-2.5 text-xs text-fg-mid hover:bg-hover hover:no-underline"
              >
                <Search className="size-3" aria-hidden />
                {t("monitors", "searchError")}
              </OutLink>
            )}
          </div>
        </div>
      )}

      {beat.query !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[7px] border border-hair px-3 py-2 text-[11.5px] text-fg-mut">
          <Search className="size-3 flex-none" aria-hidden />
          <span>{t("monitors", "askedOfPrometheus")}</span>
          <code className="min-w-0 break-all font-mono text-[11.5px] text-fg">
            {beat.query}
          </code>
          <span className="ml-auto flex flex-none gap-1.5">
            <button
              type="button"
              onClick={() => copy(beat.query!)}
              className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-hair px-2 text-[11px] text-fg-mid hover:bg-hover"
            >
              <Copy className="size-3" aria-hidden />
              {t("monitors", "copyQuery")}
            </button>
            {base !== null && (
              <OutLink
                href={`${base}/graph?g0.expr=${encodeURIComponent(beat.query)}&g0.tab=0`}
                site="Prometheus"
                className="h-6 rounded-[5px] border border-hair px-2 text-[11px] text-fg-mid hover:bg-hover hover:no-underline"
              >
                <ExternalLink className="size-3" aria-hidden />
                {t("monitors", "openInPrometheus")}
              </OutLink>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function verdictOf(
  row: MonitorRow,
  instanceCount: number,
  since: number | null,
  lastScrapeAgo: string | null,
  t: T
): { head: string; body: ReactNode } {
  const worst = row.findings[0];
  const { scrape } = row;
  switch (worst?.kind) {
    case "selectsNothing":
      return {
        head: t("monitors", "verdictSelectsNothing"),
        body: t("monitors", "verdictSelectsNothingBody", {
          selector: selectorWords(row.monitor.selector) || "{}",
          namespace: row.monitor.namespace,
        }),
      };
    case "selectionUnread":
      return {
        head: t("monitors", "verdictSelectionUnread"),
        body: worst.reason,
      };
    case "notPickedUp":
      return instanceCount === 0
        ? { head: t("monitors", "verdictNoInstances"), body: null }
        : {
            head: t("monitors", "verdictNotPickedUp"),
            body: t("monitors", "notPickedUp"),
          };
    case "pickedUpUnknown":
      return {
        head: t("monitors", "verdictPickedUpUnknown"),
        body: worst.reason,
      };
    case "targetsDown":
      return {
        head:
          since !== null
            ? t("monitors", "verdictDownSince", {
                down: worst.down,
                total: worst.total,
                since: clock(since),
              })
            : t("monitors", "verdictDown", {
                down: worst.down,
                total: worst.total,
              }),
        body: worst.lastError ? (
          <>
            {t("monitors", "prometheusSays")}:{" "}
            <span className="select-text break-all font-mono text-[11.5px] text-fg-mid">
              {worst.lastError}
            </span>
          </>
        ) : null,
      };
    case "noTargets":
      return {
        head: t("monitors", "verdictNoTargets"),
        body: t("monitors", "noTargets"),
      };
  }
  if (row.pickedUp.state === "noKind")
    return { head: t("monitors", "verdictNoKind"), body: null };
  if (scrape.state === "notConnected")
    return {
      head: t("monitors", "verdictNotChecked"),
      body: t("monitors", "notConnected"),
    };
  if (scrape.state === "unanswered")
    return {
      head: t("monitors", "verdictNotChecked"),
      body: t("monitors", "unanswered", { reason: scrape.reason }),
    };
  return {
    head: t("monitors", "verdictUp", {
      n: scrape.up,
      ago: lastScrapeAgo ?? "?",
    }),
    body: t("monitors", "nothingToDo"),
  };
}

function HeartbeatPanel({
  row,
  beat,
  since,
}: {
  row: MonitorRow;
  beat: ReturnType<typeof useHeartbeat>;
  since: number | null;
}) {
  const t = useT();
  const { scrape } = row;
  if (scrape.state !== "read") return null;
  const lanes = beat.lanes ?? [];
  const shownLanes = lanes.slice(0, 4);
  const interval = row.monitor.endpoints[0]?.interval ?? null;
  return (
    <div
      className={cn(
        "grid grid-cols-[92px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border border-hair px-3 py-2.5"
      )}
    >
      <div className="text-[11px] text-fg-fnt">
        <b className="block text-xs font-medium text-fg">
          {t("monitors", "lastHour")}
        </b>
        {t("monitors", "perCell")}
      </div>
      <div className="flex min-w-0 flex-col gap-[3px]">
        {beat.unread !== null ? (
          <p className="text-[11px] text-warn">
            {t("monitors", "heartbeatUnread", { reason: beat.unread })}
          </p>
        ) : beat.lanes === null ? (
          <p className="text-[11px] text-fg-fnt">…</p>
        ) : (
          <>
            {shownLanes.map((lane) => (
              <div
                key={lane.instance}
                className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-2"
              >
                <span className="truncate font-mono text-[10.5px] text-fg-fnt">
                  {lane.instance}
                </span>
                <Strip cells={lane.cells} height="h-3" />
              </div>
            ))}
            {lanes.length > shownLanes.length && (
              <span className="font-mono text-[10.5px] text-fg-fnt">
                {t("monitors", "moreLanes", {
                  n: lanes.length - shownLanes.length,
                })}
              </span>
            )}
            {beat.window !== null && (
              <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-2">
                <span />
                <span className="flex justify-between font-mono text-[9.5px] text-fg-fnt">
                  <span>{clock(beat.window.from)}</span>
                  <span>{clock((beat.window.from + beat.window.to) / 2)}</span>
                  <span>{clock(beat.window.to)}</span>
                </span>
              </div>
            )}
          </>
        )}
      </div>
      <div className="text-right text-[11px] leading-snug text-fg-mut">
        {scrape.down > 0 ? (
          <>
            <b className="block font-mono text-[12.5px] font-medium text-err">
              {t("monitors", "downCount", { n: scrape.down })}
            </b>
            {since !== null &&
              t("monitors", "sinceTime", { time: clock(since) })}
          </>
        ) : (
          <>
            <b className="block font-mono text-[12.5px] font-medium text-ok">
              {t("monitors", "upCount", { n: scrape.up })}
            </b>
            {interval && t("monitors", "everyInterval", { interval })}
          </>
        )}
      </div>
    </div>
  );
}

const selectsTone = (row: MonitorRow): RowTone =>
  row.selected.kind === "unread"
    ? "warn"
    : row.selected.kind === "notCounted"
      ? "mut"
      : row.selected.names.length === 0
        ? "err"
        : "ok";

const selectsCount = (row: MonitorRow, t: T): string | null =>
  row.selected.kind === "services" && row.selected.names.length > 0
    ? t("monitors", "selectsServices", { n: row.selected.names.length })
    : null;

function PickedUpStep({
  row,
  instances,
  t,
}: {
  row: MonitorRow;
  instances: PrometheusInstance[];
  t: T;
}) {
  const { pickedUp, monitor } = row;
  const by =
    pickedUp.state === "noKind"
      ? []
      : instances.filter((instance) => pickedUp.by.includes(instance.name));
  const tone: RowTone =
    pickedUp.state === "noKind"
      ? "mut"
      : pickedUp.by.length > 0
        ? "ok"
        : pickedUp.state === "unknown"
          ? "warn"
          : "err";
  return (
    <Step
      tone={tone}
      title={t("monitors", "pickedUpBy")}
      count={
        pickedUp.state === "noKind"
          ? t("monitors", "notJudged")
          : pickedUp.by.length > 0
            ? t("monitors", "pickedUpCount", { n: pickedUp.by.length })
            : null
      }
      last={false}
    >
      {by.map((instance) => {
        const objects =
          monitor.kind === "ServiceMonitor"
            ? instance.serviceMonitorSelector
            : instance.podMonitorSelector;
        const scope =
          monitor.kind === "ServiceMonitor"
            ? instance.serviceMonitorNamespaceSelector
            : instance.podMonitorNamespaceSelector;
        const bad = instance.availableCondition?.status === "False";
        return (
          <div
            key={instance.uid}
            className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-[6px] border border-info/35 bg-info/5 px-2.5 py-2 text-[11.5px] text-fg-mut"
          >
            <Link
              to={crdObjectPath(
                PROMETHEUSES_CRD,
                instance.namespace,
                instance.name
              )}
              className="col-span-2 font-mono text-xs text-fg hover:underline"
            >
              {instance.namespace}/{instance.name}
            </Link>
            <span
              className={cn(
                "font-mono text-[10.5px]",
                bad ? "text-err" : "text-fg-fnt"
              )}
            >
              {instance.available === null
                ? t("monitors", "readyUnknown")
                : t("monitors", "readyOf", {
                    ready: instance.available,
                    wanted: instance.replicas ?? 1,
                  })}
            </span>
            <span className="text-fg-mid">
              {[
                instance.version,
                instance.retention
                  ? t("monitors", "retention", { value: instance.retention })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {bad && instance.availableCondition?.message && (
                <span className="block font-mono text-[10.5px] text-err">
                  {instance.availableCondition.message}
                </span>
              )}
            </span>
            <span className="font-mono text-[10.5px] text-fg-fnt">
              {t("monitors", "picksUp")}
            </span>
            <span className="text-fg-mid">
              {selectorIsEmpty(objects) &&
              scope !== null &&
              selectorIsEmpty(scope)
                ? t("monitors", "picksUpAll")
                : selectorIsEmpty(objects) && scope === null
                  ? t("monitors", "picksUpOwn")
                  : `${t("monitors", "picksUpMatching", { selector: selectorWords(objects) || "{}" })}${
                      scope === null
                        ? ""
                        : `, ${t("monitors", "inNamespacesMatching", { selector: selectorWords(scope) || "{}" })}`
                    }`}
            </span>
          </div>
        );
      })}
      {pickedUp.state === "judged" && pickedUp.by.length === 0 && (
        <p className="text-xs text-err">
          {instances.length === 0
            ? t("monitors", "verdictNoInstances")
            : t("monitors", "notPickedUp")}
        </p>
      )}
      {pickedUp.state === "unknown" && pickedUp.by.length === 0 && (
        <p className="text-xs text-warn">
          {t("monitors", "pickedUpUnknown", { reason: pickedUp.reason })}
        </p>
      )}
      {pickedUp.state === "noKind" && (
        <p className="text-xs text-fg-mut">
          {t("monitors", "prometheusKindAbsent")}
        </p>
      )}
    </Step>
  );
}

function TargetsStep({ row, now, t }: { row: MonitorRow; now: number; t: T }) {
  const { scrape } = row;
  if (scrape.state === "notConnected")
    return (
      <Step
        tone="mut"
        title={t("monitors", "targets")}
        count={t("monitors", "notChecked")}
        last
      >
        <p className="text-xs text-fg-mut">{t("monitors", "notConnected")}</p>
      </Step>
    );
  if (scrape.state === "unanswered")
    return (
      <Step
        tone="warn"
        title={t("monitors", "targets")}
        count={t("monitors", "notChecked")}
        last
      >
        <p className="text-xs text-warn">
          {t("monitors", "unanswered", { reason: scrape.reason })}
        </p>
      </Step>
    );
  if (scrape.targets.length === 0)
    return (
      <Step
        tone={row.findings.some((f) => f.kind === "noTargets") ? "warn" : "mut"}
        title={t("monitors", "targets")}
        count={t("monitors", "noTargetYet")}
        last
      >
        <p className="text-xs text-fg-mut">{t("monitors", "noTargets")}</p>
      </Step>
    );
  const shown = scrape.targets.slice(0, 6);
  return (
    <Step
      tone={scrape.down > 0 ? "err" : "ok"}
      title={t("monitors", "targets")}
      count={rowWords(row, t)}
      last
    >
      <div className="mt-1 overflow-hidden rounded-[7px] border border-hair">
        <div className="grid grid-cols-[54px_minmax(0,1.2fr)_110px_minmax(0,1.4fr)] gap-2.5 border-b border-hair bg-hover px-3 py-1.5 text-[10.5px] text-fg-fnt">
          <span>{t("monitors", "health")}</span>
          <span>{t("monitors", "scrapeUrl")}</span>
          <span>{t("monitors", "lastScrape")}</span>
          <span>{t("monitors", "lastError")}</span>
        </div>
        {shown.map((target) => (
          <div
            key={target.scrapeUrl + target.scrapePool}
            className="grid grid-cols-[54px_minmax(0,1.2fr)_110px_minmax(0,1.4fr)] items-center gap-2.5 border-b border-hair px-3 py-1.5 text-xs last:border-b-0"
          >
            <span
              className={cn(
                "font-mono text-[11px]",
                target.health === "up"
                  ? "text-ok"
                  : target.health === "down"
                    ? "text-err"
                    : "text-fg-fnt"
              )}
            >
              {target.health}
            </span>
            <span className="break-all font-mono text-[11.5px] text-fg-mid">
              {target.scrapeUrl}
            </span>
            <span className="text-[11px] tabular-nums text-fg-fnt">
              {target.lastScrape
                ? t("monitors", "scrapedAgo", {
                    ago: formatSince(Date.parse(target.lastScrape), now),
                  })
                : "–"}
            </span>
            <span
              className={cn(
                "break-all font-mono text-[11px]",
                target.lastError ? "text-err" : "text-fg-fnt"
              )}
            >
              {target.lastError || "–"}
            </span>
          </div>
        ))}
        {scrape.targets.length > shown.length && (
          <p className="px-3 py-1.5 text-[11px] text-fg-fnt">
            {t("monitors", "moreTargets", {
              n: scrape.targets.length - shown.length,
            })}
          </p>
        )}
      </div>
    </Step>
  );
}

const STEP_GLYPH: Record<RowTone, ReactNode> = {
  err: <X className="size-3" aria-hidden />,
  warn: <AlertTriangle className="size-3" aria-hidden />,
  ok: <Check className="size-3" aria-hidden />,
  none: <X className="size-3" aria-hidden />,
  mut: <HelpCircle className="size-3" aria-hidden />,
};

const STEP_RING: Record<RowTone, string> = {
  err: "border-err text-err",
  warn: "border-warn text-warn",
  ok: "border-ok text-ok",
  none: "border-err text-err",
  mut: "border-dashed border-fg-fnt text-fg-fnt",
};

function Step({
  tone,
  title,
  count,
  last,
  children,
}: {
  tone: RowTone;
  title: string;
  count: string | null;
  last: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-3 pb-4">
      {!last && (
        <i
          className="absolute bottom-0 left-[10px] top-[22px] w-px bg-hair"
          aria-hidden
        />
      )}
      <span
        className={cn(
          "z-[1] flex size-[22px] items-center justify-center rounded-full border-[1.5px] bg-canvas",
          STEP_RING[tone]
        )}
      >
        {STEP_GLYPH[tone]}
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "flex items-baseline gap-2 text-[12.5px] font-medium leading-[22px]",
            tone === "err" || tone === "none"
              ? "text-err"
              : tone === "warn"
                ? "text-warn"
                : "text-fg"
          )}
        >
          {title}
          {count && (
            <span className="font-mono text-[11.5px] font-medium text-fg-mut">
              {count}
            </span>
          )}
        </p>
        <div className="text-xs text-fg-mut">{children}</div>
      </div>
    </div>
  );
}

function Chips({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 flex flex-wrap gap-1.5">{children}</div>;
}

function Chip({
  label,
  tone,
  children,
}: {
  label?: string;
  tone?: "err" | "mut";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 font-mono text-[11px]",
        tone === "err"
          ? "border-err/45 text-err"
          : tone === "mut"
            ? "border-dashed border-hair text-fg-fnt"
            : "border-hair text-fg-mid"
      )}
    >
      {label && <Sub>{label}</Sub>}
      {children}
    </span>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="font-sans text-[10px] text-fg-fnt">{children}</span>;
}

function hintWhy(hint: Hint, t: T): string {
  switch (hint.key) {
    case "loopback":
      return t("monitors", "hintLoopbackWhy", {
        component: hint.component,
        port: hint.port,
      });
    case "refused":
      return t("monitors", "hintRefusedWhy", { port: hint.port });
    case "notFound":
      return t("monitors", "hintNotFoundWhy", {
        path: hint.path,
        port: hint.port,
      });
    case "unauthorized":
      return t("monitors", "hintUnauthorizedWhy");
    case "tls":
      return t("monitors", "hintTlsWhy");
    case "timeout":
      return t("monitors", "hintTimeoutWhy");
    case "dns":
      return t("monitors", "hintDnsWhy");
    case "selectsNothing":
      return t("monitors", "hintSelectsNothingWhy", {
        selector: hint.selector || "{}",
        namespace: hint.namespace,
      });
    case "podPort":
      return t("monitors", "hintPodPortWhy", { port: hint.port });
    case "noEndpoints":
      return t("monitors", "hintNoEndpointsWhy", { port: hint.port });
  }
}

const LOOPBACK_FLAG: Record<string, string> = {
  "kube-controller-manager": "--bind-address=0.0.0.0",
  "kube-scheduler": "--bind-address=0.0.0.0",
  etcd: "--listen-metrics-urls=http://0.0.0.0:2381",
  "kube-proxy": "metricsBindAddress: 0.0.0.0:10249",
};

function hintHow(hint: Hint, t: T): string {
  switch (hint.key) {
    case "loopback":
      return t("monitors", "hintLoopbackHow", {
        flag: LOOPBACK_FLAG[hint.component] ?? "",
      });
    case "refused":
      return t("monitors", "hintRefusedHow");
    case "notFound":
      return t("monitors", "hintNotFoundHow");
    case "unauthorized":
      return t("monitors", "hintUnauthorizedHow");
    case "tls":
      return t("monitors", "hintTlsHow");
    case "timeout":
      return t("monitors", "hintTimeoutHow");
    case "dns":
      return t("monitors", "hintDnsHow");
    case "selectsNothing":
      return t("monitors", "hintSelectsNothingHow");
    case "podPort":
      return t("monitors", "hintPodPortHow");
    case "noEndpoints":
      return t("monitors", "hintNoEndpointsHow");
  }
}

/** What a reader pastes to an assistant: the object, the words, the guess. */
function agentNote(row: MonitorRow, hint: Hint, t: T): string {
  const lines = [
    `${row.monitor.kind} ${row.monitor.namespace}/${row.monitor.name}`,
    `${t("monitors", "selects")}: ${selectorWords(row.monitor.selector) || "{}"}`,
    ...row.monitor.endpoints.map(
      (e) =>
        `${t("monitors", "endpoints")}: port ${e.port ?? "?"} path ${e.path}${e.interval ? ` every ${e.interval}` : ""}`
    ),
    `${t("monitors", "targets")}: ${rowWords(row, t)}`,
  ];
  if (row.scrape.state === "read")
    for (const target of row.scrape.targets)
      lines.push(
        `  ${target.health} ${target.scrapeUrl}${target.lastError ? ` ${target.lastError}` : ""}`
      );
  lines.push(
    `${t("monitors", "mostLikely")}: ${hintWhy(hint, t)} ${hintHow(hint, t)}`
  );
  return lines.join("\n");
}
