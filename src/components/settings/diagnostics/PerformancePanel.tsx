import * as React from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ClipboardCopy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { SettingRow, SettingsGroup } from "@/components/settings/settings-row";
import { commands } from "@/lib/commands";
import { logInfo } from "@/lib/logger";
import { perf } from "@/lib/perf";
import type { PerfReport, PerfStats } from "@/lib/perf";
import { startFrameWatch } from "@/lib/perf-frames";
import { useT } from "@/i18n/useT";

function useReport(): PerfReport | null {
  const [report, setReport] = React.useState(() => perf.report());
  React.useEffect(() => perf.subscribe(() => setReport(perf.report())), []);
  return report;
}

const ms = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`;
const kb = (n: number) =>
  n >= 1_048_576
    ? `${(n / 1_048_576).toFixed(1)} MiB`
    : `${Math.round(n / 1024)} KiB`;

function StatsRows({
  rows,
  nameLabel,
}: {
  rows: [string, PerfStats][];
  nameLabel: string;
}) {
  const t = useT();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-fg-fnt">
          <tr>
            <th className="py-1 pr-3 text-left font-medium">{nameLabel}</th>
            <th className="py-1 pr-3 text-right font-medium">
              {t("settings", "perfCount")}
            </th>
            <th className="py-1 pr-3 text-right font-medium">p50</th>
            <th className="py-1 pr-3 text-right font-medium">p95</th>
            <th className="py-1 pr-3 text-right font-medium">max</th>
            <th className="py-1 pr-3 text-right font-medium">
              {t("settings", "perfRows")}
            </th>
            <th className="py-1 text-right font-medium">
              {t("settings", "perfBytes")}
            </th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums text-fg-mid">
          {rows.map(([name, s]) => (
            <tr key={name} className="border-t border-hair">
              <td className="py-1 pr-3 font-sans text-fg">{name}</td>
              <td className="py-1 pr-3 text-right">{s.count}</td>
              <td className="py-1 pr-3 text-right">{ms(s.p50)}</td>
              <td className="py-1 pr-3 text-right">{ms(s.p95)}</td>
              <td className="py-1 pr-3 text-right">{ms(s.max)}</td>
              <td className="py-1 pr-3 text-right">{s.maxRows ?? "–"}</td>
              <td className="py-1 text-right">
                {s.maxBytes !== undefined ? kb(s.maxBytes) : "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Start and stop a recording, and read it back. Off by default because every
 * answer is serialised twice while it runs; the hint says so.
 */
export function PerformancePanel() {
  const t = useT();
  const { toast } = useToast();
  const report = useReport();
  const stopFrames = React.useRef<(() => void) | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => () => stopFrames.current?.(), []);

  const start = async () => {
    setBusy(true);
    try {
      await commands.perfSetRecording(true);
      perf.start();
      stopFrames.current = startFrameWatch();
    } catch (error) {
      logInfo(`perf recording did not start: ${String(error)}`, {
        context: "perf",
      });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      stopFrames.current?.();
      stopFrames.current = null;
      try {
        perf.backend = await commands.perfCounters();
      } finally {
        perf.stop();
        await commands.perfSetRecording(false);
      }
    } catch (error) {
      logInfo(`perf counters were not read: ${String(error)}`, {
        context: "perf",
      });
    } finally {
      setBusy(false);
    }
  };

  const ipcRows = Object.entries(report?.ipc ?? {}).sort(
    (a, b) => b[1].p95 - a[1].p95
  );
  const renderRows = Object.entries(report?.renders ?? {}).sort(
    (a, b) => b[1].p95 - a[1].p95
  );

  return (
    <SettingsGroup title={t("settings", "perfTitle")} className="mt-6">
      <SettingRow
        label={t("settings", "perfRecording")}
        hint={t("settings", "perfHint")}
        control={
          perf.recording ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={stop}>
              {t("settings", "perfStop")}
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={busy} onClick={start}>
              {t("settings", "perfStart")}
            </Button>
          )
        }
      />
      {report && (
        <div className="flex flex-col gap-4 py-3 text-xs">
          <p className="text-fg-mut">
            {t("settings", "perfSummary", {
              seconds: Math.round(report.durationMs / 1000),
              ipc: ipcRows.reduce((n, [, s]) => n + s.count, 0),
              tasks: report.tasks?.count ?? 0,
            })}{" "}
            {report.taskSource === "frame-gap"
              ? t("settings", "perfTaskSourceFrames")
              : report.taskSource === "longtask"
                ? t("settings", "perfTaskSourceObserver")
                : ""}
          </p>
          {ipcRows.length > 0 && (
            <StatsRows
              rows={ipcRows}
              nameLabel={t("settings", "perfCommand")}
            />
          )}
          {report.tasks && (
            <p className="text-fg-mid">
              {t("settings", "perfTasks")}: {report.tasks.count} · p95{" "}
              {ms(report.tasks.p95)} · max {ms(report.tasks.max)}
            </p>
          )}
          {renderRows.length > 0 ? (
            <StatsRows
              rows={renderRows}
              nameLabel={t("settings", "perfRenders")}
            />
          ) : (
            <p className="text-fg-fnt">{t("settings", "perfNoRenders")}</p>
          )}
          {report.backend && (
            <p className="text-fg-mid">
              {t("settings", "perfBackend", {
                events: report.backend.eventsEmitted,
                bytes: kb(report.backend.eventBytes),
                max: kb(report.backend.maxEventBytes),
                changes: report.backend.watchChanges,
              })}
            </p>
          )}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await writeText(JSON.stringify(report, null, 2));
                toast({ title: t("settings", "perfCopied") });
              }}
            >
              <ClipboardCopy className="mr-1.5 h-3.5 w-3.5" />
              {t("settings", "perfCopy")}
            </Button>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
