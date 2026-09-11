import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Section, SectionHeader } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import { Cell, Finding, FilterBox, TroubleRow, type Tone } from "../page-kit";
import { crdObjectPath } from "../kit";
import { usePicture, useServiceMonitors, useTargets } from "./data";
import {
  POD_MONITORS_CRD,
  PROMETHEUSES_CRD,
  SERVICE_MONITORS_CRD,
  readMonitor,
  readPrometheus,
  rowsOf,
  type MonitorRow,
  type PrometheusInstance,
  type TargetsRead,
} from "./model";

type T = ReturnType<typeof useT>;

export default function PrometheusOperatorPage() {
  const t = useT();
  const [filter, setFilter] = useState("");
  const monitorsQuery = useServiceMonitors();
  const picture = usePicture();
  const targets = useTargets();

  const rows = useMemo(() => {
    if (!monitorsQuery.data || !picture.data) return null;
    const { podMonitors, prometheuses, services, namespaces } = picture.data;
    const monitors = [
      ...monitorsQuery.data.map((cr) => readMonitor(cr, "ServiceMonitor")),
      ...(podMonitors.ok
        ? podMonitors.items.map((cr) => readMonitor(cr, "PodMonitor"))
        : []),
    ];
    const instances = prometheuses.ok
      ? prometheuses.items.map(readPrometheus)
      : [];
    return rowsOf(
      monitors,
      instances,
      services,
      namespaces,
      targets.data ?? { state: "notConnected" }
    );
  }, [monitorsQuery.data, picture.data, targets.data]);

  if (monitorsQuery.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("monitors", "couldNotReadMonitors")}
        </h2>
        <p className="text-[11px] text-fg-fnt">{monitorsQuery.error.message}</p>
      </Section>
    );
  }

  const needle = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter(
    (row) =>
      needle === "" ||
      row.monitor.name.toLowerCase().includes(needle) ||
      row.monitor.namespace.toLowerCase().includes(needle)
  );
  const troubled = (rows ?? []).filter((row) => row.worst !== null);
  const instances = picture.data?.prometheuses.ok
    ? picture.data.prometheuses.items.map(readPrometheus)
    : null;

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Prometheus Operator"
        count={
          rows === null
            ? undefined
            : troubled.length > 0
              ? t("monitors", "needAttention", {
                  n: troubled.length,
                  total: rows.length,
                })
              : String(rows.length)
        }
        description={t("monitors", "pageHint")}
      />

      <Instances
        instances={instances}
        unread={
          picture.data && !picture.data.prometheuses.ok
            ? picture.data.prometheuses.reason
            : null
        }
      />

      <ScrapeTruth targets={targets.data ?? null} />

      {picture.data && !picture.data.podMonitors.ok && (
        <Finding
          tone="warn"
          title={t("monitors", "kindUnread", {
            kind: "PodMonitor",
            reason: picture.data.podMonitors.reason,
          })}
        />
      )}

      <Section>
        <div className="mb-3 flex items-center gap-3">
          <FilterBox
            value={filter}
            onChange={setFilter}
            placeholder={t("monitors", "filterMonitors")}
            label={t("monitors", "filterMonitorsLabel")}
          />
        </div>
        {rows === null ? (
          <p className="text-[11px] text-fg-fnt">…</p>
        ) : rows.length === 0 ? (
          <p className="text-[11.5px] text-fg-mut">{t("monitors", "none")}</p>
        ) : shown.length === 0 ? (
          <p className="text-[11.5px] text-fg-mut">
            {t("monitors", "noneMatch")}
          </p>
        ) : (
          shown.map((row, index) => (
            <MonitorLine
              key={row.monitor.uid}
              row={row}
              last={index === shown.length - 1}
            />
          ))
        )}
      </Section>
    </div>
  );
}

function Instances({
  instances,
  unread,
}: {
  instances: PrometheusInstance[] | null;
  unread: string | null;
}) {
  const t = useT();
  return (
    <Section>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-fnt">
        {t("monitors", "instances")}
      </h3>
      {unread !== null ? (
        <Finding
          tone="warn"
          title={t("monitors", "instancesUnread")}
          verbatim={unread}
        />
      ) : instances === null ? (
        <p className="text-[11px] text-fg-fnt">…</p>
      ) : instances.length === 0 ? (
        <p className="text-[11.5px] text-fg-mut">
          {t("monitors", "noInstances")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {instances.map((instance) => {
            const available = instance.availableCondition;
            const bad = available?.status === "False";
            return (
              <Link
                key={instance.uid}
                to={crdObjectPath(
                  PROMETHEUSES_CRD,
                  instance.namespace,
                  instance.name
                )}
                className={cn(
                  "flex min-w-[220px] flex-col gap-0.5 rounded border border-hair px-2.5 py-2 hover:bg-hover",
                  bad && "border-err/60"
                )}
              >
                <span className="truncate font-mono text-[12px] text-fg">
                  {instance.namespace}/{instance.name}
                </span>
                <span
                  className={cn(
                    "text-[11px]",
                    bad ? "text-err" : "text-fg-mut"
                  )}
                >
                  {instance.available === null
                    ? t("monitors", "readyUnknown")
                    : t("monitors", "readyOf", {
                        ready: instance.available,
                        wanted: instance.replicas ?? 1,
                      })}
                  {instance.version ? ` · ${instance.version}` : ""}
                  {instance.retention
                    ? ` · ${t("monitors", "retention", { value: instance.retention })}`
                    : ""}
                </span>
                {bad && available?.message && (
                  <span className="font-mono text-[10.5px] text-fg-mut">
                    {available.message}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function ScrapeTruth({ targets }: { targets: TargetsRead | null }) {
  const t = useT();
  return (
    <Section>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-fnt">
        {t("monitors", "scrapeTruth")}
      </h3>
      {targets === null ? (
        <p className="text-[11px] text-fg-fnt">…</p>
      ) : targets.state === "notConnected" ? (
        <p className="text-[11.5px] text-fg-mut">
          {t("monitors", "notConnected")}{" "}
          <Link
            to="/settings/integrations?vendor=prometheus"
            className="text-info hover:underline"
          >
            {t("monitors", "connectPrometheus")}
          </Link>
        </p>
      ) : targets.state === "unanswered" ? (
        <Finding
          tone="warn"
          title={t("monitors", "unanswered", { reason: targets.reason })}
        />
      ) : (
        <p className="text-[11.5px] text-fg-mut">
          {t("monitors", "targetsRead", { n: targets.targets.length })}
        </p>
      )}
    </Section>
  );
}

function stateOf(row: MonitorRow, t: T): { text: string; tone: Tone } {
  const worst = row.findings[0];
  if (worst) {
    const tone: Tone = worst.severity;
    switch (worst.kind) {
      case "selectsNothing":
        return { text: t("monitors", "rowSelectsNothing"), tone };
      case "notPickedUp":
        return { text: t("monitors", "rowNotPickedUp"), tone };
      case "targetsDown":
        return { text: t("monitors", "rowDown"), tone };
      case "noTargets":
        return { text: t("monitors", "rowNoTargets"), tone };
      default:
        return { text: t("monitors", "rowUnknown"), tone };
    }
  }
  if (row.scrape.state !== "read")
    return { text: t("monitors", "rowNotChecked"), tone: "warn" };
  return { text: t("monitors", "rowOk"), tone: "ok" };
}

function MonitorLine({ row, last }: { row: MonitorRow; last: boolean }) {
  const t = useT();
  const { monitor, selected, pickedUp, scrape } = row;
  const state = stateOf(row, t);
  return (
    <TroubleRow
      title={monitor.name}
      reference={{
        kind: monitor.kind,
        name: monitor.name,
        namespace: monitor.namespace,
        crd:
          monitor.kind === "ServiceMonitor"
            ? SERVICE_MONITORS_CRD
            : POD_MONITORS_CRD,
      }}
      meta={`${monitor.kind} · ${monitor.namespace}`}
      state={state}
      openByDefault={row.worst === "err"}
      last={last}
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <Cell
          title={t("monitors", "selects")}
          bad={selected.kind === "services" && selected.names.length === 0}
          warn={selected.kind === "unread"}
        >
          {selected.kind === "services"
            ? selected.names.length === 0
              ? t("monitors", "rowSelectsNothing")
              : t("monitors", "selectsServices", { n: selected.names.length })
            : selected.kind === "notCounted"
              ? t("monitors", "notCounted")
              : t("monitors", "rowUnknown")}
        </Cell>
        <Cell
          title={t("monitors", "pickedUpBy")}
          bad={pickedUp.known && pickedUp.by.length === 0}
          warn={!pickedUp.known}
        >
          {pickedUp.by.length > 0
            ? pickedUp.by.join(", ")
            : pickedUp.known
              ? t("monitors", "rowNotPickedUp")
              : t("monitors", "rowUnknown")}
        </Cell>
        <Cell
          title={t("monitors", "scraped")}
          bad={scrape.state === "read" && scrape.down > 0}
          warn={scrape.state !== "read"}
        >
          {scrape.state === "read"
            ? scrape.down > 0
              ? t("monitors", "targetsDown", {
                  down: scrape.down,
                  total: scrape.up + scrape.down + scrape.unknown,
                })
              : t("monitors", "scrapedUp", { up: scrape.up })
            : t("monitors", "notChecked")}
        </Cell>
        <Cell title={t("monitors", "endpoints")}>
          {monitor.endpoints.length === 0
            ? "-"
            : monitor.endpoints
                .map(
                  (endpoint) =>
                    `${endpoint.port ?? "?"} ${endpoint.path}${
                      endpoint.interval
                        ? ` · ${t("monitors", "everyInterval", { interval: endpoint.interval })}`
                        : ""
                    }`
                )
                .join("; ")}
        </Cell>
      </div>
      {row.findings.map((finding, index) => (
        <Finding
          key={`${finding.kind}-${index}`}
          tone={finding.severity}
          title={
            finding.kind === "selectsNothing"
              ? t("monitors", "selectsNothing")
              : finding.kind === "selectionUnread"
                ? t("monitors", "selectionUnread", { reason: finding.reason })
                : finding.kind === "notPickedUp"
                  ? t("monitors", "notPickedUp")
                  : finding.kind === "pickedUpUnknown"
                    ? t("monitors", "pickedUpUnknown", {
                        reason: finding.reason,
                      })
                    : finding.kind === "targetsDown"
                      ? t("monitors", "targetsDown", {
                          down: finding.down,
                          total: finding.total,
                        })
                      : t("monitors", "noTargets")
          }
          verbatim={finding.kind === "targetsDown" ? finding.lastError : null}
        />
      ))}
      {selected.kind === "services" && selected.names.length > 0 && (
        <p className="font-mono text-[11px] text-fg-mut">
          {selected.names.join(", ")}
        </p>
      )}
    </TroubleRow>
  );
}
