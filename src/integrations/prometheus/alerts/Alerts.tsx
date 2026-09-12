import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Bell,
  Check,
  Copy,
  ExternalLink,
  HelpCircle,
  X,
} from "lucide-react";

import { ObjectLink } from "@/components/resources/ResourceRef";
import { Section } from "@/components/ui/section";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useNow } from "@/hooks/useNow";
import { useT, type T } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { cn, formatSince } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { crdObjectPath } from "../../kit";
import { FilterBox, Finding, OutLink } from "../../page-kit";
import { integrationSettingsPath } from "../../paths";
import { usePicture, type Picture } from "../monitors/data";
import {
  PROMETHEUSES_CRD,
  readPrometheus,
  sharedPrefix,
} from "../monitors/model";
import { Chip, Chips, Step, Sub } from "../monitors/story";
import { DOT, RING, SELECTED, WORDS, type RowTone } from "../monitors/words";
import { rowWords } from "./words";
import {
  OBJECT_LABEL,
  RULES_CRD,
  readRule,
  rowsOf,
  type RuleGroup,
  type RuleRow,
  type RuleState,
} from "./model";

const GROUPS: readonly RuleGroup[] = [
  "firing",
  "broken",
  "pending",
  "quiet",
  "unchecked",
];

const keyOf = (row: RuleRow) => `${row.object.namespace}/${row.object.name}`;

const TONE: Record<RuleGroup, RowTone> = {
  firing: "err",
  broken: "none",
  pending: "warn",
  quiet: "ok",
  unchecked: "mut",
};

export default function Alerts() {
  const t = useT();
  const picture = usePicture();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState<RuleGroup | null>(null);

  const rows = useMemo(() => {
    if (!picture.data || picture.data.rules.state !== "read") return null;
    const instances =
      picture.data.prometheuses.state === "read"
        ? {
            state: "read" as const,
            items: picture.data.prometheuses.items.map(readPrometheus),
          }
        : picture.data.prometheuses;
    return rowsOf(
      picture.data.rules.items.map(readRule),
      instances,
      picture.data.namespaces,
      picture.data.alertRules
    );
  }, [picture.data]);
  const prefix = useMemo(
    () => (rows ? sharedPrefix(rows.map((row) => row.object.name)) : null),
    [rows]
  );
  const shown = useMemo(() => {
    if (!rows) return [];
    const needle = filter.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (only === null || row.group === only) &&
        (needle === "" ||
          row.object.name.toLowerCase().includes(needle) ||
          row.object.namespace.toLowerCase().includes(needle) ||
          row.object.rules.some((r) => r.alert.toLowerCase().includes(needle)))
    );
  }, [rows, filter, only]);

  const asked = params.get("rule");
  const selected =
    shown.find((row) => keyOf(row) === asked) ?? shown[0] ?? null;
  const select = (row: RuleRow) => {
    const updated = new URLSearchParams(params);
    updated.set("rule", keyOf(row));
    setParams(updated, { replace: true });
  };
  const open = (row: RuleRow) =>
    navigate(crdObjectPath(RULES_CRD, row.object.namespace, row.object.name));
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
          {t("alerts", "couldNotRead")}
        </h2>
        <p className="text-[11px] text-fg-fnt">{picture.error.message}</p>
      </Section>
    );
  }
  if (!picture.data) return <p className="text-[11px] text-fg-fnt">…</p>;
  if (picture.data.rules.state === "unread") {
    return (
      <Finding
        tone="warn"
        title={t("alerts", "kindUnread", {
          reason: picture.data.rules.reason,
        })}
      />
    );
  }
  if (!rows) return null;

  return (
    <div className="flex flex-col gap-4">
      <Header picture={picture.data} rows={rows} />
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
        />
        {selected ? (
          <Detail key={keyOf(selected)} row={selected} picture={picture.data} />
        ) : (
          <p className="text-[11.5px] text-fg-mut">
            {rows.length === 0 ? t("alerts", "none") : t("alerts", "noneMatch")}
          </p>
        )}
      </div>
    </div>
  );
}

function Header({ picture, rows }: { picture: Picture; rows: RuleRow[] }) {
  const t = useT();
  const read = picture.alertRules;
  const firing = rows.filter((row) => row.group === "firing").length;
  const broken = rows.filter((row) => row.group === "broken").length;
  const alerts =
    read.state === "read"
      ? read.rules.reduce(
          (n, rule) =>
            n + rule.alerts.filter((a) => a.state === "firing").length,
          0
        )
      : null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
      <div className="min-w-0 max-w-[60ch]">
        <p className="text-[13px] font-semibold tracking-tight text-fg">
          {alerts === null
            ? t("alerts", "objects", { n: rows.length })
            : alerts > 0
              ? t("alerts", "firingNow", { n: alerts, rules: firing })
              : t("alerts", "quietNow", { n: rows.length })}
          {broken > 0 && (
            <span className="ml-2 font-normal text-err">
              {t("alerts", "brokenCount", { n: broken })}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-fg-mut">{t("alerts", "pageHint")}</p>
      </div>
      {read.state === "notConnected" ? (
        <Note tone="info">
          {t("alerts", "notConnected")}{" "}
          <Link
            to={integrationSettingsPath("prometheus")}
            className="text-info hover:underline"
          >
            {t("monitors", "connectPrometheus")}
          </Link>
        </Note>
      ) : read.state === "unanswered" ? (
        <Note tone="warn">
          {t("alerts", "unanswered", { reason: read.reason })}
        </Note>
      ) : (
        <p className="text-[11px] text-fg-fnt">
          {t("alerts", "rulesLoaded", { n: read.rules.length })}
        </p>
      )}
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

const GROUP_KEY: Record<
  RuleGroup,
  | "groupFiring"
  | "groupBroken"
  | "groupPending"
  | "groupQuiet"
  | "groupUnchecked"
> = {
  firing: "groupFiring",
  broken: "groupBroken",
  pending: "groupPending",
  quiet: "groupQuiet",
  unchecked: "groupUnchecked",
};

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
}: {
  rows: RuleRow[];
  shown: RuleRow[];
  prefix: string | null;
  selected: RuleRow | null;
  filter: string;
  only: RuleGroup | null;
  onFilter: (value: string) => void;
  onOnly: (group: RuleGroup | null) => void;
  onSelect: (row: RuleRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  const counts = new Map<RuleGroup, number>();
  for (const row of rows)
    counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
  const chips: Array<[RuleGroup | null, number]> = [
    [null, rows.length],
    ...GROUPS.filter((group) => counts.has(group)).map(
      (group): [RuleGroup, number] => [group, counts.get(group) ?? 0]
    ),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2 border-r border-hair pr-3">
      <FilterBox
        value={filter}
        onChange={onFilter}
        placeholder={t("alerts", "filter")}
        label={t("alerts", "filterLabel")}
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
            {group !== null && (
              <i
                className={cn("size-1.5 rounded-full", DOT[TONE[group]])}
                aria-hidden
              />
            )}
            <b className="font-mono font-medium text-fg">{n}</b>
            {group === null
              ? t("monitors", "chipAll")
              : t("alerts", GROUP_KEY[group]).toLowerCase()}
          </button>
        ))}
      </div>
      <div
        role="listbox"
        aria-label={t("alerts", "filterLabel")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex flex-col rounded-[5px] outline-none focus-visible:ring-1 focus-visible:ring-info"
      >
        {GROUPS.map((group) => {
          const members = shown.filter((row) => row.group === group);
          if (members.length === 0) return null;
          return (
            <div key={group} className="flex flex-col">
              <p className="flex items-center gap-2 px-2 pb-0.5 pt-2.5 text-[10px] font-semibold uppercase tracking-[.07em] text-fg-fnt">
                {t("alerts", GROUP_KEY[group])}
                <b className="font-mono font-medium normal-case tracking-normal text-fg-mut">
                  {members.length}
                </b>
                <i className="h-px flex-1 bg-hair" />
              </p>
              {members.map((row) => (
                <Row
                  key={row.object.uid}
                  row={row}
                  prefix={prefix}
                  on={row === selected}
                  onSelect={onSelect}
                  t={t}
                />
              ))}
            </div>
          );
        })}
        {shown.length === 0 && (
          <p className="px-2 py-3 text-[11.5px] text-fg-mut">
            {rows.length === 0 ? t("alerts", "none") : t("alerts", "noneMatch")}
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

function Row({
  row,
  prefix,
  on,
  onSelect,
  t,
}: {
  row: RuleRow;
  prefix: string | null;
  on: boolean;
  onSelect: (row: RuleRow) => void;
  t: T;
}) {
  const tone = TONE[row.group];
  const folded = prefix !== null && row.object.name.startsWith(prefix);
  const shortName = folded
    ? row.object.name.slice(prefix.length)
    : row.object.name;
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
          title={row.object.name}
        >
          {shortName}
        </p>
        <p className="truncate text-[11px] leading-[15px] text-fg-fnt">
          {row.object.namespace}
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
          "whitespace-nowrap text-right font-mono text-[11px] leading-4",
          WORDS[tone]
        )}
      >
        {rowWords(row, t)}
        <span className="block font-sans text-[10px] leading-[14px] text-fg-fnt">
          {t("alerts", "ruleCount", { n: row.object.rules.length })}
        </span>
      </div>
    </div>
  );
}

const CARD: Record<RowTone, string> = {
  err: "border-err/45 bg-err/7",
  warn: "border-warn/45 bg-warn/7",
  ok: "border-ok/40 bg-ok/6",
  none: "border-err/45 bg-err/7",
  mut: "border-dashed border-hair bg-hover",
};

const TONE_TEXT: Record<RowTone, string> = {
  err: "text-err",
  warn: "text-warn",
  ok: "text-ok",
  none: "text-err",
  mut: "text-fg-fnt",
};

const ICON: Record<RowTone, typeof X> = {
  err: Bell,
  warn: AlertTriangle,
  ok: Check,
  none: X,
  mut: HelpCircle,
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Detail({ row, picture }: { row: RuleRow; picture: Picture }) {
  const t = useT();
  const now = useNow();
  const copy = useCopyToClipboard();
  const context = useClusterStore((state) => state.currentContext);
  const saved = useQuery({
    queryKey: [context, "prometheus", "page-address"],
    queryFn: () => commands.getPrometheusConnection(),
    staleTime: 60_000,
  });
  const base = saved.data?.url.replace(/\/+$/, "") ?? null;
  const tone = TONE[row.group];
  const Icon = ICON[tone];
  const { object, pickedUp, loaded } = row;
  const instances =
    picture.prometheuses.state === "read"
      ? picture.prometheuses.items.map(readPrometheus)
      : [];
  const by =
    pickedUp.state === "noKind"
      ? []
      : instances.filter((instance) => pickedUp.by.includes(instance.name));
  const verdict = verdictOf(row, instances.length, t);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="break-all font-mono text-[15px] font-medium tracking-tight text-fg">
            {object.name}
          </span>
          <span className="text-[11.5px] text-fg-fnt">
            PrometheusRule ·{" "}
            <span className="font-mono text-fg-mut">{object.namespace}</span>
            {object.recording > 0 &&
              ` · ${t("alerts", "recordingCount", { n: object.recording })}`}
          </span>
        </div>
        <div className="flex flex-none gap-1.5">
          <Link
            to={crdObjectPath(RULES_CRD, object.namespace, object.name)}
            className="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-hair px-2.5 text-xs text-fg-mid hover:bg-hover"
          >
            {t("monitors", "openObject")}
          </Link>
          {base !== null && loaded.state === "read" && (
            <OutLink
              href={`${base}/alerts?search=${encodeURIComponent(object.name)}`}
              site="Prometheus"
              className="h-7 rounded-[5px] border border-hair px-2.5 text-xs text-fg-mid hover:bg-hover hover:no-underline"
            >
              {t("alerts", "inPrometheus")}
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

      <div className="flex flex-col">
        <Step
          tone={
            pickedUp.state === "noKind"
              ? "mut"
              : pickedUp.by.length > 0
                ? "ok"
                : pickedUp.state === "unknown"
                  ? "warn"
                  : "err"
          }
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
          <Chips>
            {Object.entries(object.labels).map(([key, value]) => (
              <Chip key={key} label={t("monitors", "chipLabel")}>
                {key}={value}
              </Chip>
            ))}
          </Chips>
          {by.map((instance) => (
            <p key={instance.uid} className="mt-1.5 font-mono text-xs text-fg">
              <Link
                to={crdObjectPath(
                  PROMETHEUSES_CRD,
                  instance.namespace,
                  instance.name
                )}
                className="hover:underline"
              >
                {instance.namespace}/{instance.name}
              </Link>
            </p>
          ))}
          {pickedUp.state === "judged" && pickedUp.by.length === 0 && (
            <p className="mt-1 text-xs text-err">
              {instances.length === 0
                ? t("monitors", "verdictNoInstances")
                : t("alerts", "notPickedUp")}
            </p>
          )}
          {pickedUp.state === "unknown" && pickedUp.by.length === 0 && (
            <p className="mt-1 text-xs text-warn">
              {t("monitors", "pickedUpUnknown", { reason: pickedUp.reason })}
            </p>
          )}
          {pickedUp.state === "noKind" && (
            <p className="mt-1 text-xs text-fg-mut">
              {t("monitors", "prometheusKindAbsent")}
            </p>
          )}
        </Step>

        <Step
          tone={
            loaded.state !== "read"
              ? loaded.state === "unanswered"
                ? "warn"
                : "mut"
              : loaded.files.length === 0
                ? "err"
                : loaded.rules.some((r) => r.loaded === null)
                  ? "err"
                  : "ok"
          }
          title={t("alerts", "loaded")}
          count={
            loaded.state !== "read"
              ? t("monitors", "notChecked")
              : loaded.files.length === 0
                ? t("alerts", "notLoadedShort")
                : t("alerts", "loadedOf", {
                    n: loaded.rules.filter((r) => r.loaded !== null).length,
                    total: loaded.rules.length,
                  })
          }
          last={false}
        >
          {loaded.state === "notConnected" && (
            <p className="text-xs text-fg-mut">{t("alerts", "notConnected")}</p>
          )}
          {loaded.state === "unanswered" && (
            <p className="text-xs text-warn">
              {t("alerts", "unanswered", { reason: loaded.reason })}
            </p>
          )}
          {loaded.state === "read" && loaded.files.length === 0 && (
            <p className="text-xs text-fg-mut">{t("alerts", "notLoaded")}</p>
          )}
          {loaded.state === "read" && loaded.files.length > 0 && (
            <Chips>
              {loaded.files.map((file) => (
                <Chip key={file} label={t("alerts", "chipFile")}>
                  {file.slice(file.lastIndexOf("/") + 1)}
                </Chip>
              ))}
            </Chips>
          )}
        </Step>

        <Step
          tone={
            loaded.state !== "read"
              ? "mut"
              : row.group === "firing"
                ? "err"
                : row.group === "pending"
                  ? "warn"
                  : loaded.rules.some(
                        (r) => r.loaded === null || r.loaded.health === "err"
                      )
                    ? "none"
                    : "ok"
          }
          title={t("alerts", "rules")}
          count={t("alerts", "ruleCount", { n: object.rules.length })}
          last
        >
          <div className="mt-1 flex flex-col gap-2">
            {(loaded.state === "read"
              ? loaded.rules
              : object.rules.map((spec) => ({ spec, loaded: null }))
            ).map((rule) => (
              <RuleCard
                key={`${rule.spec.group}/${rule.spec.alert}`}
                rule={rule}
                checked={loaded.state === "read"}
                base={base}
                now={now}
                onCopy={(text) => void copy(text)}
                t={t}
              />
            ))}
          </div>
        </Step>
      </div>
    </div>
  );
}

function verdictOf(
  row: RuleRow,
  instanceCount: number,
  t: T
): { head: string; body: string | null } {
  const worst = row.findings[0];
  switch (worst?.kind) {
    case "firing":
      return {
        head: t("alerts", "verdictFiring", {
          n: worst.alerts,
          rules: worst.rules,
        }),
        body: null,
      };
    case "notPickedUp":
      return instanceCount === 0
        ? { head: t("monitors", "verdictNoInstances"), body: null }
        : {
            head: t("alerts", "verdictNotPickedUp"),
            body: t("alerts", "notPickedUp"),
          };
    case "notLoaded":
      return {
        head: t("alerts", "verdictNotLoaded"),
        body: t("alerts", "notLoaded"),
      };
    case "partlyLoaded":
      return {
        head: t("alerts", "verdictPartlyLoaded", { n: worst.missing.length }),
        body: worst.missing.join(", "),
      };
    case "evalError":
      return {
        head: t("alerts", "verdictEvalError", { rule: worst.rule }),
        body: worst.lastError,
      };
    case "pending":
      return {
        head: t("alerts", "verdictPending", {
          n: worst.alerts,
          rules: worst.rules,
        }),
        body: null,
      };
    case "pickedUpUnknown":
      return {
        head: t("monitors", "verdictPickedUpUnknown"),
        body: worst.reason,
      };
  }
  if (row.pickedUp.state === "noKind")
    return { head: t("monitors", "verdictNoKind"), body: null };
  if (row.loaded.state === "notConnected")
    return {
      head: t("alerts", "verdictNotChecked"),
      body: t("alerts", "notConnected"),
    };
  if (row.loaded.state === "unanswered")
    return {
      head: t("alerts", "verdictNotChecked"),
      body: t("alerts", "unanswered", { reason: row.loaded.reason }),
    };
  return {
    head: t("alerts", "verdictQuiet", { n: row.object.rules.length }),
    body: t("monitors", "nothingToDo"),
  };
}

const STATE_TONE: Record<string, string> = {
  firing: "text-err",
  pending: "text-warn",
  inactive: "text-fg-fnt",
};

function RuleCard({
  rule,
  checked,
  base,
  now,
  onCopy,
  t,
}: {
  rule: RuleState;
  checked: boolean;
  base: string | null;
  now: number;
  onCopy: (text: string) => void;
  t: T;
}) {
  const { spec, loaded } = rule;
  const state = loaded?.state ?? null;
  const active =
    loaded?.alerts.filter(
      (a) => a.state === "firing" || a.state === "pending"
    ) ?? [];
  return (
    <div
      className={cn(
        "rounded-[7px] border px-3 py-2",
        state === "firing"
          ? "border-err/45"
          : state === "pending"
            ? "border-warn/45"
            : loaded?.health === "err"
              ? "border-err/45 border-dashed"
              : "border-hair"
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-xs font-medium text-fg">
          {spec.alert}
        </span>
        <span
          className={cn(
            "font-mono text-[11px]",
            state ? (STATE_TONE[state] ?? "text-fg-fnt") : "text-fg-fnt"
          )}
        >
          {state ??
            (checked
              ? t("alerts", "notInPrometheus")
              : t("monitors", "notChecked"))}
        </span>
        {spec.for && (
          <span className="text-[11px] text-fg-fnt">
            <Sub>for</Sub> {spec.for}
          </span>
        )}
        {(spec.labels.severity ?? loaded?.labels.severity) && (
          <span className="text-[11px] text-fg-fnt">
            <Sub>severity</Sub>{" "}
            {spec.labels.severity ?? loaded?.labels.severity}
          </span>
        )}
        <span className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={() => onCopy(spec.expr)}
            className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-hair px-2 text-[11px] text-fg-mid hover:bg-hover"
          >
            <Copy className="size-3" aria-hidden />
            {t("monitors", "copyQuery")}
          </button>
          {base !== null && (
            <OutLink
              href={`${base}/graph?g0.expr=${encodeURIComponent(spec.expr)}&g0.tab=0`}
              site="Prometheus"
              className="h-6 rounded-[5px] border border-hair px-2 text-[11px] text-fg-mid hover:bg-hover hover:no-underline"
            >
              <ExternalLink className="size-3" aria-hidden />
              {t("monitors", "openInPrometheus")}
            </OutLink>
          )}
        </span>
      </div>
      {loaded?.health === "err" && loaded.lastError && (
        <p className="mt-1 select-text break-all font-mono text-[11px] text-err">
          {loaded.lastError}
        </p>
      )}
      {(spec.annotations.summary ?? spec.annotations.description) && (
        <p className="mt-1 text-[11.5px] text-fg-mut">
          {spec.annotations.summary ?? spec.annotations.description}
        </p>
      )}
      <code className="mt-1.5 block select-text break-all font-mono text-[11px] text-fg-mid">
        {spec.expr}
      </code>
      {active.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-[6px] border border-hair">
          {active.slice(0, 8).map((alert, index) => {
            const subject = subjectOf(alert.labels);
            return (
              <div
                key={index}
                className="grid grid-cols-[54px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-hair px-2.5 py-1.5 text-xs last:border-b-0"
              >
                <span
                  className={cn(
                    "font-mono text-[11px]",
                    STATE_TONE[alert.state] ?? "text-fg-fnt"
                  )}
                >
                  {alert.state}
                </span>
                <span className="min-w-0 truncate">
                  {subject ? (
                    <ObjectLink
                      kind={subject.kind}
                      name={subject.name}
                      namespace={subject.namespace}
                    >
                      {subject.namespace ? `${subject.namespace}/` : ""}
                      {subject.name}
                    </ObjectLink>
                  ) : (
                    <span className="font-mono text-fg-mid">
                      {Object.entries(alert.labels)
                        .filter(([k]) => k !== "alertname" && k !== "severity")
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" ")}
                    </span>
                  )}
                  {alert.annotations.summary && (
                    <span className="ml-2 text-fg-fnt">
                      {alert.annotations.summary}
                    </span>
                  )}
                </span>
                <span className="text-[11px] tabular-nums text-fg-fnt">
                  {alert.activeAt
                    ? t("alerts", "since", {
                        time: clock(alert.activeAt),
                        ago: formatSince(Date.parse(alert.activeAt), now),
                      })
                    : "–"}
                </span>
              </div>
            );
          })}
          {active.length > 8 && (
            <p className="px-2.5 py-1.5 text-[11px] text-fg-fnt">
              {t("alerts", "moreAlerts", { n: active.length - 8 })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The object an alert is about, from the first object label it carries. */
function subjectOf(
  labels: Record<string, string>
): { kind: string; name: string; namespace: string | null } | null {
  for (const [kind, label] of Object.entries(OBJECT_LABEL)) {
    if (kind === "Namespace") continue;
    const name = labels[label];
    if (name)
      return {
        kind,
        name,
        namespace: kind === "Node" ? null : (labels.namespace ?? null),
      };
  }
  return null;
}
