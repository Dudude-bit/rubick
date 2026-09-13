import { useMemo, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Section } from "@/components/ui/section";
import { useT } from "@/i18n/useT";
import type { T } from "@/i18n/useT";
import type { RowTone } from "./words";
import { cn, formatSince } from "@/lib/utils";
import { crdObjectPath } from "../../kit";
import { integrationSettingsPath } from "../../paths";
import { Finding, FilterBox } from "../../page-kit";
import { Detail } from "./Detail";
import { useHeartbeat } from "./heartbeat";
import { Strip } from "./Strip";
import { useNow } from "@/hooks/useNow";
import { rowsOfPicture, usePicture, type Picture } from "./data";
import { DOT, RING, SELECTED, WORDS, rowTone, rowWords } from "./words";
import {
  POD_MONITORS_CRD,
  SERVICE_MONITORS_CRD,
  groupOf,
  sharedPrefix,
  type Group,
  type Kind,
  type MonitorRow,
  type TargetsRead,
} from "./model";

const GROUPS: readonly Group[] = ["broken", "waiting", "scraped", "unchecked"];

const keyOf = (row: MonitorRow) =>
  `${row.monitor.namespace}/${row.monitor.name}`;

export default function Monitors() {
  const t = useT();
  const picture = usePicture();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState<Group | null>(null);

  const rows = useMemo(
    () => (picture.data ? rowsOfPicture(picture.data) : null),
    [picture.data]
  );
  const prefix = useMemo(
    () => (rows ? sharedPrefix(rows.map((row) => row.monitor.name)) : null),
    [rows]
  );
  const shown = useMemo(() => {
    if (!rows) return [];
    const needle = filter.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (only === null || groupOf(row) === only) &&
        (needle === "" ||
          row.monitor.name.toLowerCase().includes(needle) ||
          row.monitor.namespace.toLowerCase().includes(needle))
    );
  }, [rows, filter, only]);

  const asked = params.get("monitor");
  const selected =
    shown.find((row) => keyOf(row) === asked) ?? shown[0] ?? null;
  const select = (row: MonitorRow) => {
    const updated = new URLSearchParams(params);
    updated.set("monitor", keyOf(row));
    setParams(updated, { replace: true });
  };
  const open = (row: MonitorRow) =>
    navigate(
      crdObjectPath(
        row.monitor.kind === "ServiceMonitor"
          ? SERVICE_MONITORS_CRD
          : POD_MONITORS_CRD,
        row.monitor.namespace,
        row.monitor.name
      )
    );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selected) return;
    const index = shown.indexOf(selected);
    if (event.key === "ArrowDown" && index < shown.length - 1) {
      event.preventDefault();
      select(shown[index + 1]);
    } else if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      select(shown[index - 1]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(selected);
    }
  };

  if (picture.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("monitors", "couldNotReadMonitors")}
        </h2>
        <p className="text-[11px] text-fg-fnt">{picture.error.message}</p>
      </Section>
    );
  }
  if (!picture.data || !rows) {
    return <p className="text-[11px] text-fg-fnt">…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Header picture={picture.data} rows={rows} />
      <Notices picture={picture.data} />
      <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-6 border-t border-hair pt-4">
        <Ladder
          rows={rows}
          shown={shown}
          prefix={prefix}
          selected={selected}
          filter={filter}
          only={only}
          onFilter={setFilter}
          onOnly={setOnly}
          onSelect={select}
          onKeyDown={onKeyDown}
          targets={picture.data.targets}
        />
        {selected ? (
          <Detail key={keyOf(selected)} row={selected} picture={picture.data} />
        ) : (
          <p className="text-[11.5px] text-fg-mut">
            {rows.length === 0
              ? t("monitors", "none")
              : t("monitors", "noneMatch")}
          </p>
        )}
      </div>
    </div>
  );
}

function Header({ picture, rows }: { picture: Picture; rows: MonitorRow[] }) {
  const t = useT();
  const attention = rows.filter((row) => row.worst !== null).length;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
      <div className="min-w-0 max-w-[60ch]">
        <p className="text-[13px] font-semibold tracking-tight text-fg">
          {attention > 0
            ? t("monitors", "needAttention", {
                n: attention,
                total: rows.length,
              })
            : t("monitors", "allScraped", { n: rows.length })}
        </p>
        <p className="mt-0.5 text-xs text-fg-mut">
          {t("monitors", "pageHint")}
        </p>
      </div>
      <ScrapeTruth targets={picture.targets} />
    </div>
  );
}

function ScrapeTruth({ targets }: { targets: TargetsRead }) {
  const t = useT();
  if (targets.state === "notConnected") {
    return (
      <Note tone="info">
        {t("monitors", "notConnected")}{" "}
        <Link
          to={integrationSettingsPath("prometheus")}
          className="text-info hover:underline"
        >
          {t("monitors", "connectPrometheus")}
        </Link>
      </Note>
    );
  }
  if (targets.state === "unanswered") {
    return (
      <Note tone="warn">
        {t("monitors", "unanswered", { reason: targets.reason })}
      </Note>
    );
  }
  const up = targets.targets.filter((x) => x.health === "up").length;
  const down = targets.targets.filter((x) => x.health === "down").length;
  const total = targets.targets.length;
  const unknown = total - up - down;
  const share = total === 0 ? 0 : up / total;
  const tone = share >= 0.9 ? "ok" : share >= 0.5 ? "warn" : "err";
  const r = 23;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4">
      <div className="relative size-14 flex-none">
        <svg viewBox="0 0 56 56" className="size-14 -rotate-90" aria-hidden>
          <circle
            cx="28"
            cy="28"
            r={r}
            fill="none"
            className="stroke-hair"
            strokeWidth="5"
          />
          <circle
            cx="28"
            cy="28"
            r={r}
            fill="none"
            className={cn(
              tone === "ok"
                ? "stroke-ok"
                : tone === "warn"
                  ? "stroke-warn"
                  : "stroke-err"
            )}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${c * share} ${c}`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center font-mono text-[12.5px] leading-none text-fg">
          {up}
          <span className="mt-0.5 font-sans text-[9px] text-fg-fnt">
            {t("monitors", "ofTotal", { total })}
          </span>
        </div>
      </div>
      <div className="flex min-w-[230px] flex-col gap-1.5">
        <p className="text-[11px] text-fg-fnt">
          {t("monitors", "targetsRead", { n: total })}
        </p>
        <div className="flex h-[7px] gap-px overflow-hidden rounded">
          {up > 0 && <i className="bg-ok" style={{ flex: up }} />}
          {down > 0 && <i className="bg-err" style={{ flex: down }} />}
          {unknown > 0 && <i className="bg-fg-fnt" style={{ flex: unknown }} />}
        </div>
        <p className="flex gap-3 font-mono text-[11px] text-fg-mut">
          <span>
            <b className="font-medium text-fg">{up}</b> up
          </span>
          <span>
            <b className="font-medium text-fg">{down}</b> down
          </span>
          <span>
            <b className="font-medium text-fg">{unknown}</b> unknown
          </span>
        </p>
      </div>
    </div>
  );
}

function Note({
  tone,
  children,
}: {
  tone: "info" | "warn";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "max-w-[52ch] rounded-[5px] border px-3 py-2 text-[11.5px] leading-relaxed text-fg-mut",
        tone === "warn"
          ? "border-warn/45 bg-warn/5"
          : "border-info/40 bg-info/5"
      )}
    >
      {children}
    </p>
  );
}

/** The cluster-wide facts, said once here rather than on every row. */
function Notices({ picture }: { picture: Picture }) {
  const t = useT();
  const kinds: Array<[string, Kind<unknown>]> = [
    ["ServiceMonitor", picture.serviceMonitors],
    ["PodMonitor", picture.podMonitors],
  ];
  const notices: React.ReactNode[] = [];
  for (const [kind, read] of kinds) {
    if (read.state === "absent")
      notices.push(
        <p key={kind} className="text-[11.5px] text-fg-fnt">
          {t("monitors", "kindAbsent", { kind })}
        </p>
      );
    else if (read.state === "unread")
      notices.push(
        <Finding
          key={kind}
          tone="warn"
          title={t("monitors", "kindUnread", { kind, reason: read.reason })}
        />
      );
  }
  const instances = picture.prometheuses;
  if (instances.state === "absent")
    notices.push(
      <p key="prometheus" className="text-[11.5px] text-fg-fnt">
        {t("monitors", "prometheusKindAbsent")}
      </p>
    );
  else if (instances.state === "unread")
    notices.push(
      <Finding
        key="prometheus"
        tone="warn"
        title={t("monitors", "instancesUnread")}
        verbatim={instances.reason}
      />
    );
  else if (instances.items.length === 0)
    notices.push(
      <Finding
        key="prometheus"
        tone="err"
        title={t("monitors", "noInstances")}
      />
    );
  if (notices.length === 0) return null;
  return <div className="flex flex-col gap-1.5">{notices}</div>;
}

function Ladder({
  rows,
  shown,
  prefix,
  selected,
  filter,
  only,
  onFilter,
  onOnly,
  onSelect,
  onKeyDown,
  targets,
}: {
  rows: MonitorRow[];
  shown: MonitorRow[];
  prefix: string | null;
  selected: MonitorRow | null;
  filter: string;
  only: Group | null;
  onFilter: (value: string) => void;
  onOnly: (group: Group | null) => void;
  onSelect: (row: MonitorRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  targets: TargetsRead;
}) {
  const t = useT();
  const now = useNow();
  const counts = new Map<Group, number>();
  for (const row of rows)
    counts.set(groupOf(row), (counts.get(groupOf(row)) ?? 0) + 1);
  const chips: Array<[Group | null, number]> = [
    [null, rows.length],
    ...GROUPS.filter((group) => counts.has(group)).map(
      (group): [Group, number] => [group, counts.get(group) ?? 0]
    ),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2 border-r border-hair pr-3">
      <FilterBox
        value={filter}
        onChange={onFilter}
        placeholder={t("monitors", "filterMonitors")}
        label={t("monitors", "filterMonitorsLabel")}
        className="w-full"
      />
      <div className="flex flex-wrap gap-1.5">
        {chips.map(([group, n]) => (
          <button
            key={group ?? "all"}
            type="button"
            onClick={() => onOnly(group)}
            aria-pressed={only === group}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-[5px] border px-2 text-[11px] whitespace-nowrap",
              only === group
                ? "border-transparent bg-sel text-fg"
                : "border-hair text-fg-mut hover:bg-hover"
            )}
          >
            {group !== null && <Dot group={group} targets={targets} />}
            <b className="font-mono font-medium text-fg">{n}</b>
            {t(
              "monitors",
              group === null ? "chipAll" : chipKey(group, targets)
            )}
          </button>
        ))}
      </div>
      <div
        role="listbox"
        aria-label={t("monitors", "filterMonitorsLabel")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex flex-col outline-none focus-visible:ring-1 focus-visible:ring-info rounded-[5px]"
      >
        {GROUPS.map((group) => {
          const members = shown.filter((row) => groupOf(row) === group);
          if (members.length === 0) return null;
          return (
            <div key={group} className="flex flex-col">
              <p className="flex items-center gap-2 px-2 pb-0.5 pt-2.5 text-[10px] font-semibold uppercase tracking-[.07em] text-fg-fnt">
                {t("monitors", groupKey(group, targets))}
                <b className="font-mono font-medium normal-case tracking-normal text-fg-mut">
                  {members.length}
                </b>
                <i className="h-px flex-1 bg-hair" />
              </p>
              {members.map((row) => (
                <Row
                  key={row.monitor.uid}
                  row={row}
                  prefix={prefix}
                  on={row === selected}
                  onSelect={onSelect}
                  now={now}
                  t={t}
                />
              ))}
            </div>
          );
        })}
        {shown.length === 0 && (
          <p className="px-2 py-3 text-[11.5px] text-fg-mut">
            {rows.length === 0
              ? t("monitors", "none")
              : t("monitors", "noneMatch")}
          </p>
        )}
      </div>
      <p className="mt-auto flex gap-3 border-t border-hair pt-2 text-[10.5px] text-fg-fnt">
        <span>{t("monitors", "keysMove")}</span>
        <span>{t("monitors", "keysOpen")}</span>
      </p>
    </div>
  );
}

const chipKey = (group: Group, targets: TargetsRead) =>
  group === "broken"
    ? "chipBroken"
    : group === "waiting"
      ? "chipWaiting"
      : targets.state === "read"
        ? "chipScraped"
        : "chipUnchecked";

const groupKey = (group: Group, targets: TargetsRead) =>
  group === "broken"
    ? "groupBroken"
    : group === "waiting"
      ? "groupWaiting"
      : targets.state === "read"
        ? "groupScraped"
        : "groupUnchecked";

function Dot({ group, targets }: { group: Group; targets: TargetsRead }) {
  const tone: RowTone =
    group === "broken"
      ? "err"
      : group === "waiting"
        ? "warn"
        : targets.state === "read"
          ? "ok"
          : "mut";
  return <i className={cn("size-1.5 rounded-full", DOT[tone])} aria-hidden />;
}

function Row({
  row,
  prefix,
  on,
  onSelect,
  now,
  t,
}: {
  row: MonitorRow;
  prefix: string | null;
  on: boolean;
  onSelect: (row: MonitorRow) => void;
  now: number;
  t: T;
}) {
  const tone = rowTone(row);
  const folded = prefix !== null && row.monitor.name.startsWith(prefix);
  const shortName = folded
    ? row.monitor.name.slice(prefix.length)
    : row.monitor.name;
  const ago =
    row.scrape.state === "read" && row.scrape.lastScrape
      ? formatSince(Date.parse(row.scrape.lastScrape), now)
      : null;
  return (
    <div
      role="option"
      aria-selected={on}
      onClick={() => onSelect(row)}
      className={cn(
        "relative mx-1 grid cursor-pointer grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[5px] py-1.5 pl-2.5 pr-2 transition-colors",
        on ? SELECTED[tone] : "hover:bg-hover",
        on &&
          "after:absolute after:-right-[17px] after:top-1/2 after:size-[9px] after:-translate-y-1/2 after:rotate-45 after:border-r after:border-t after:border-hair after:bg-canvas after:content-['']"
      )}
    >
      <i
        className={cn("size-2 rounded-full", DOT[tone], on && RING[tone])}
        aria-hidden
      />
      <div className="min-w-0">
        <p
          className={cn(
            "truncate font-mono text-[12px] leading-4",
            on ? "text-fg" : "text-fg-mid"
          )}
          title={row.monitor.name}
        >
          {shortName}
          {row.monitor.kind === "PodMonitor" && (
            <span className="ml-1.5 rounded-[3px] border border-hair px-1 align-[1px] font-sans text-[9.5px] text-fg-fnt">
              PodMonitor
            </span>
          )}
        </p>
        <p className="truncate text-[11px] leading-[15px] text-fg-fnt">
          {row.monitor.namespace}
          {folded && (
            <span className="font-mono text-[10px] opacity-70">
              {" · "}
              {prefix.replace(/-$/, "")}
            </span>
          )}
        </p>
      </div>
      <div
        className={cn(
          "text-right font-mono text-[11px] leading-4 whitespace-nowrap",
          WORDS[tone]
        )}
      >
        {rowWords(row, t)}
        {ago !== null && (
          <span className="block font-sans text-[10px] leading-[14px] text-fg-fnt">
            {t("monitors", "scrapedAgo", { ago })}
          </span>
        )}
      </div>
      {on && <Heartbeat row={row} />}
    </div>
  );
}

function Heartbeat({ row }: { row: MonitorRow }) {
  const { lanes } = useHeartbeat(row);
  if (lanes === null || lanes.length === 0) return null;
  const cells = lanes[0].cells.map((_, index) =>
    lanes.some((lane) => lane.cells[index] === "down")
      ? "down"
      : lanes.some((lane) => lane.cells[index] === "up")
        ? "up"
        : "none"
  );
  return (
    <div className="col-span-2 col-start-2 mt-1.5">
      <Strip cells={cells} height="h-1.5" />
    </div>
  );
}
