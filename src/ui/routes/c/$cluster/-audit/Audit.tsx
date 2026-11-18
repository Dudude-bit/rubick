import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, EyeOff, ShieldCheck } from "lucide-react";

import type {
  AuditPage,
  AuditQuery,
  AuditRow,
  AuditSeverity,
  Category,
  RuleId,
  Subject,
} from "@/generated/types";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { DataTable } from "@/components/ui/data-table";
import type { ColumnDef } from "@/components/ui/table-features";
import { Section, SectionBody, SectionHeader } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Unknown } from "@/components/ui/unknown";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useAppSearchValue, useSetSearch } from "@/hooks/useSearchParam";
import { useT, type T } from "@/i18n/useT";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";
import { auditScreenSection, filterWords } from "./audit-share";
import { AuditSummaryBlock } from "./AuditSummary";
import {
  FindingList,
  RuleExplained,
  RuleHeading,
  SeverityBadge,
  WhatLine,
} from "./FindingList";
import {
  CATEGORIES,
  CATEGORY_WORDS,
  RULE_IDS,
  RULE_META,
  SEVERITIES,
  SEVERITY_WORDS,
  ruleTitle,
  standardWords,
  uncheckedWords,
} from "./rules";
import { subjectKey, subjectOf, subjectTitle } from "./subjects";
import { SubjectRef } from "./SubjectRef";
import { useAuditPage, useObjectAudit } from "./useAudit";

const PAGE = 100;
const EVERY = "*";

const isSeverity = (value: string | undefined): value is AuditSeverity =>
  SEVERITIES.includes(value as AuditSeverity);
const isCategory = (value: string | undefined): value is Category =>
  CATEGORIES.includes(value as Category);
const isRule = (value: string | undefined): value is RuleId =>
  RULE_IDS.includes(value as RuleId);

type RuleRow = Extract<AuditRow, { row: "rule" }>;
type ObjectRow = Extract<AuditRow, { row: "object" }>;

function ruleColumns(t: T): ColumnDef<RuleRow>[] {
  return [
    {
      id: "severity",
      header: t("audit", "severity"),
      size: 90,
      accessorFn: (row) => (row.worst ? SEVERITIES.indexOf(row.worst) : 3),
      cell: ({ row }) =>
        row.original.worst ? (
          <SeverityBadge severity={row.original.worst} />
        ) : (
          <EyeOff
            className="h-3 w-3 text-fg-fnt"
            aria-label={t("audit", "notCheckedHere")}
          />
        ),
    },
    {
      id: "rule",
      header: t("audit", "rule"),
      size: 340,
      accessorFn: (row) => ruleTitle(row.rule, t),
    },
    {
      id: "category",
      header: t("audit", "category"),
      size: 110,
      accessorFn: (row) =>
        t("audit", CATEGORY_WORDS[RULE_META[row.rule].category]),
    },
    {
      id: "standard",
      header: t("audit", "standard"),
      size: 100,
      accessorFn: (row) => standardWords(row.rule, t),
    },
    {
      id: "objects",
      header: t("audit", "objects"),
      size: 110,
      accessorFn: (row) => row.objects,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.objects}
          {row.original.unchecked > 0 && (
            <span className="ml-1.5 text-fg-fnt">
              {t("audit", "uncheckedOf", { n: row.original.unchecked })}
            </span>
          )}
        </span>
      ),
    },
  ];
}

function objectColumns(t: T): ColumnDef<ObjectRow>[] {
  return [
    {
      id: "severity",
      header: t("audit", "severity"),
      size: 90,
      accessorFn: (row) => (row.worst ? SEVERITIES.indexOf(row.worst) : 3),
      cell: ({ row }) =>
        row.original.worst ? (
          <SeverityBadge severity={row.original.worst} />
        ) : (
          <EyeOff
            className="h-3 w-3 text-fg-fnt"
            aria-label={t("audit", "notCheckedHere")}
          />
        ),
    },
    {
      id: "namespace",
      header: t("columns", "namespace"),
      size: 140,
      accessorFn: (row) => row.subject.namespace ?? "",
    },
    {
      id: "name",
      header: t("columns", "name"),
      size: 280,
      accessorFn: (row) => `${row.subject.kind} ${row.subject.name}`,
      cell: ({ row }) => (
        <SubjectRef subject={row.original.subject} showNamespace={false} />
      ),
    },
    {
      id: "findings",
      header: t("audit", "findings"),
      size: 160,
      accessorFn: (row) =>
        row.severities.high * 10_000 +
        row.severities.medium * 100 +
        row.severities.low,
      cell: ({ row }) => {
        const { high, medium, low } = row.original.severities;
        return (
          <span className="tabular-nums">
            <span className="text-err">{high}</span>
            {" · "}
            <span className="text-warn">{medium}</span>
            {" · "}
            <span className="text-info">{low}</span>
            {row.original.unchecked > 0 && (
              <span className="ml-1.5 text-fg-fnt">
                {t("audit", "uncheckedOf", { n: row.original.unchecked })}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "worstRule",
      header: t("audit", "rule"),
      size: 260,
      accessorFn: (row) => (row.rules[0] ? ruleTitle(row.rules[0], t) : ""),
    },
  ];
}

function Pager({
  page,
  offset,
  onOffset,
}: {
  page: AuditPage | undefined;
  offset: number;
  onOffset: (offset: number) => void;
}) {
  if (!page || (offset === 0 && page.next === null)) return null;
  return (
    <div className="flex items-center justify-end gap-1 pt-1 text-[11px] text-fg-mut">
      <span className="tabular-nums">
        {offset + 1}-{offset + page.rows.length} / {page.total}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        disabled={offset === 0}
        onClick={() => onOffset(Math.max(0, offset - PAGE))}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0"
        disabled={page.next === null}
        onClick={() => page.next !== null && onOffset(page.next)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * A pager's offset, back at the first page whenever the question it pages
 * changes: another cluster, namespaces, filter or rule. An offset carried
 * over asks past the new answer's end, which reads as nothing found.
 */
function useOffsetFor(question: unknown): [number, (offset: number) => void] {
  const at = JSON.stringify(question);
  const [paged, setPaged] = useState({ at, offset: 0 });
  return [
    paged.at === at ? paged.offset : 0,
    (offset) => setPaged({ at, offset }),
  ];
}

/** One rule opened: why, how, and the objects it found, a page at a time. */
function RulePanel({ rule, base }: { rule: RuleId; base: AuditQuery }) {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const scope = useNamespaceScope();
  const [offset, setOffset] = useOffsetFor([context, scope, base, rule]);
  const query = useAuditPage({ ...base, rule, offset, limit: PAGE });
  const rows = query.data?.rows ?? [];
  const first = rows.find((row) => row.row === "found");
  return (
    <Section>
      <SectionHeader
        title={ruleTitle(rule, t)}
        description={
          <RuleHeading
            rule={rule}
            severity={RULE_META[rule].severity}
            showTitle={false}
          />
        }
      />
      <SectionBody className="flex flex-col gap-3 pt-2">
        <RuleExplained
          rule={rule}
          kind={first?.row === "found" ? first.subject.kind : "Deployment"}
          finding={first?.row === "found" ? first.finding : undefined}
          subject={first?.row === "found" ? first.subject : undefined}
        />
        {query.error ? (
          <Unknown
            question={ruleTitle(rule, t)}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-hair text-xs">
            {rows.map((row) =>
              row.row === "found" ? (
                <li
                  key={`f/${row.subject.kind}/${row.subject.namespace}/${row.subject.name}`}
                  className="flex flex-col gap-0.5 py-1.5"
                >
                  <span className="flex items-center gap-2">
                    <SeverityBadge severity={row.finding.severity} />
                    <SubjectRef subject={row.subject} />
                  </span>
                  <ul className="ml-4 text-fg-mut">
                    {row.finding.what.map((what, at) => (
                      <li key={at}>
                        <WhatLine what={what} />
                      </li>
                    ))}
                  </ul>
                </li>
              ) : row.row === "blind" ? (
                <li
                  key={`b/${row.subject.kind}/${row.subject.namespace}/${row.subject.name}`}
                  className="flex items-center gap-2 py-1.5 text-fg-mut"
                  data-blind={row.subject.name}
                >
                  <EyeOff className="h-3 w-3 flex-none" aria-hidden />
                  <SubjectRef subject={row.subject} />
                  <span>{uncheckedWords(row.unchecked, t)}</span>
                </li>
              ) : null
            )}
          </ul>
        )}
        <Pager page={query.data} offset={offset} onOffset={setOffset} />
      </SectionBody>
    </Section>
  );
}

/** One object opened: its findings, from the index the page reads. */
function ObjectPanel({ subject }: { subject: Subject }) {
  const t = useT();
  const audit = useObjectAudit(subject);
  return (
    <Section>
      <SectionHeader
        title={subjectTitle(subject, t)}
        description={<SubjectRef subject={subject} />}
      />
      <SectionBody className="pt-1">
        {audit.data ? (
          <FindingList audit={audit.data} />
        ) : audit.error ? (
          <Unknown
            question={subjectTitle(subject, t)}
            error={audit.error}
            onRetry={() => void audit.refetch()}
          />
        ) : (
          <p className="py-1 text-xs text-fg-fnt">{t("audit", "whyReading")}</p>
        )}
      </SectionBody>
    </Section>
  );
}

function Filter<V extends string>({
  label,
  every,
  value,
  options,
  onChange,
}: {
  label: string;
  every: string;
  value: V | undefined;
  options: { value: V; label: string }[];
  onChange: (value: V | undefined) => void;
}) {
  return (
    <Select
      value={value ?? EVERY}
      onValueChange={(next) =>
        onChange(next === EVERY ? undefined : (next as V))
      }
    >
      <SelectTrigger
        className="h-7 w-auto min-w-[9rem] text-xs"
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={EVERY}>{every}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Brings what a row opened to where the reader is, and the focus with it:
 * drawn under a table of forty rules, an opened panel is below the fold,
 * and a click that changes nothing in sight reads as a dead one.
 */
function useBroughtIntoView(opened: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!opened) return;
    const node = ref.current;
    node?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    node?.focus({ preventScroll: true });
  }, [opened]);
  return ref;
}

/** What is deployed in a way that will hurt later, across the window's namespaces. */
export function Audit() {
  const t = useT();
  const isConnected = useClusterStore((s) => s.isConnected);
  const context = useClusterStore((s) => s.currentContext);
  const scope = useNamespaceScope();
  const setSearch = useSetSearch();
  const view = useAppSearchValue("view") === "object" ? "object" : "rule";
  const system = useAppSearchValue("part") === "system";
  const severityParam = useAppSearchValue("severity");
  const categoryParam = useAppSearchValue("category");
  const ruleParam = useAppSearchValue("rule");
  const open = subjectOf(useAppSearchValue("open"));
  const severity = isSeverity(severityParam) ? severityParam : undefined;
  const category = isCategory(categoryParam) ? categoryParam : undefined;
  const rule = isRule(ruleParam) ? ruleParam : undefined;
  const openedRule = useBroughtIntoView(view === "rule" ? rule : undefined);
  const openedObject = useBroughtIntoView(
    view === "object" && open ? subjectKey(open) : undefined
  );

  const base: AuditQuery = useMemo(
    () => ({
      by: view,
      categories: category ? [category] : [],
      severities: severity ? [severity] : [],
      rules: view === "object" && rule ? [rule] : [],
      system,
      offset: 0,
      limit: PAGE,
    }),
    [view, category, severity, rule, system]
  );
  const [offset, setOffset] = useOffsetFor([context, scope, base]);
  const query = useAuditPage({ ...base, offset });
  const page = query.data;

  const rulesColumns = useMemo(() => ruleColumns(t), [t]);
  const objectsColumns = useMemo(() => objectColumns(t), [t]);
  const ruleRows = useMemo(
    () =>
      (page?.rows ?? []).filter((row): row is RuleRow => row.row === "rule"),
    [page]
  );
  const objectRows = useMemo(
    () =>
      (page?.rows ?? []).filter(
        (row): row is ObjectRow => row.row === "object"
      ),
    [page]
  );

  const narrowed = filterWords(base, t);
  useShareSection("audit", () =>
    page ? [auditScreenSection(page, view, t, narrowed)] : []
  );

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={t("nav", "audit")} />;
  }

  const choose = (patch: Parameters<typeof setSearch>[0]) =>
    setSearch(patch, { replace: true });
  const empty =
    page &&
    page.total === 0 &&
    (severity || category || (view === "object" && rule))
      ? t("audit", "nothingMatches")
      : undefined;

  return (
    <div className="flex flex-col gap-2">
      <SectionHeader
        title={t("audit", "title")}
        count={
          page && (
            <span className="tabular-nums">
              <span className="text-err">
                {t("audit", "high")} {page.summary.severities.high}
              </span>
              {" · "}
              <span className="text-warn">
                {t("audit", "medium")} {page.summary.severities.medium}
              </span>
              {" · "}
              <span className="text-info">
                {t("audit", "low")} {page.summary.severities.low}
              </span>
            </span>
          )
        }
        description={t("audit", "caption")}
        actions={
          <>
            <div
              className="flex items-center gap-0.5"
              role="group"
              aria-label={t("audit", "grouping")}
            >
              {(["rule", "object"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={view === candidate}
                  onClick={() =>
                    choose({
                      view: candidate === "rule" ? undefined : candidate,
                      open: undefined,
                    })
                  }
                  className={cn(
                    "h-6 whitespace-nowrap rounded px-1.5 text-[11px] transition-colors hover:bg-hover",
                    view === candidate ? "bg-sel text-fg" : "text-fg-mut"
                  )}
                >
                  {t("audit", candidate === "rule" ? "byRule" : "byObject")}
                </button>
              ))}
            </div>
            <ShareScreenAction
              screen={{ title: t("audit", "title"), scope: scope.scope }}
            />
          </>
        }
      />
      {query.error && !page ? (
        <Unknown
          question={t("audit", "title")}
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {page && (
            <AuditSummaryBlock
              page={page}
              scope={scope.inWords}
              system={system}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Filter
              label={t("audit", "category")}
              every={t("audit", "everyCategory")}
              value={category}
              options={CATEGORIES.map((value) => ({
                value,
                label: t("audit", CATEGORY_WORDS[value]),
              }))}
              onChange={(value) => choose({ category: value })}
            />
            <Filter
              label={t("audit", "severity")}
              every={t("audit", "everySeverity")}
              value={severity}
              options={SEVERITIES.map((value) => ({
                value,
                label: t("audit", SEVERITY_WORDS[value]),
              }))}
              onChange={(value) => choose({ severity: value })}
            />
            {view === "object" && (
              <Filter
                label={t("audit", "rule")}
                every={t("audit", "everyRule")}
                value={rule}
                options={RULE_IDS.map((value) => ({
                  value,
                  label: ruleTitle(value, t),
                }))}
                onChange={(value) => choose({ rule: value })}
              />
            )}
            {system && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() =>
                  choose({
                    part: undefined,
                    open: undefined,
                    rule: view === "rule" ? undefined : rule,
                  })
                }
              >
                <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                {t("audit", "systemBack")}
              </Button>
            )}
          </div>
          <Section>
            <SectionBody className="pt-1">
              {view === "rule" ? (
                <DataTable
                  columns={rulesColumns}
                  data={ruleRows}
                  isLoading={!page}
                  getRowId={(row) => row.rule}
                  onRowClick={(row) =>
                    choose({ rule: row.rule === rule ? undefined : row.rule })
                  }
                  rowLabel={t("audit", "findings")}
                  countWords={(n) => t("audit", "rulesCounted", { n })}
                  widthsKey="audit-rules"
                  emptyMessage={empty}
                  pageKeys
                  share={{ title: t("audit", "byRule"), narrowed }}
                />
              ) : (
                <DataTable
                  columns={objectsColumns}
                  data={objectRows}
                  isLoading={!page}
                  getRowId={(row) => subjectKey(row.subject)}
                  onRowClick={(row) =>
                    choose({ open: subjectKey(row.subject) })
                  }
                  rowLabel={t("audit", "objects")}
                  countWords={(n) => t("audit", "objectsOf", { n })}
                  widthsKey="audit-objects"
                  emptyMessage={empty}
                  more={page?.next !== null && page?.next !== undefined}
                  pageKeys
                  share={{ title: t("audit", "byObject"), narrowed }}
                />
              )}
              <Pager page={page} offset={offset} onOffset={setOffset} />
              {!system && page && page.summary.system.findings > 0 && (
                <button
                  type="button"
                  className="mt-1 flex items-center gap-1.5 px-1.5 py-1 text-xs text-fg-mut hover:text-fg"
                  onClick={() =>
                    choose({
                      part: "system",
                      open: undefined,
                      rule: view === "rule" ? undefined : rule,
                    })
                  }
                  data-testid="audit-system-fold"
                >
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  {t("audit", "systemFold", {
                    n: page.summary.system.findings,
                  })}
                  {page.summary.system.namespaces.length > 0 &&
                    ` (${page.summary.system.namespaces.join(", ")})`}
                </button>
              )}
            </SectionBody>
          </Section>
          <div
            ref={openedRule}
            tabIndex={-1}
            className="scroll-mt-2 outline-none"
            data-testid="audit-opened-rule"
          >
            {view === "rule" && rule && <RulePanel rule={rule} base={base} />}
          </div>
          <div
            ref={openedObject}
            tabIndex={-1}
            className="scroll-mt-2 outline-none"
            data-testid="audit-opened-object"
          >
            {view === "object" && open && <ObjectPanel subject={open} />}
          </div>
          {view === "rule" && !rule && page && page.total > 0 && (
            <p className="px-1.5 text-xs text-fg-fnt">
              {t("audit", "noneOpen")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
