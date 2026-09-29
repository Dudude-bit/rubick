import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { errorToShow } from "@/lib/error-utils";
import {
  carriesLogLines,
  renderReport,
  reportFileName,
  type Report,
} from "@/lib/report";
import {
  needsAcknowledgement,
  objectKey,
  readyToPublish,
  reportLink,
  targetColor,
} from "@/lib/share-targets";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useT } from "@/i18n/useT";
import { openExternal } from "@/lib/open-external";
import { toastError } from "@/lib/toast-error";

function WebLink({ url, className }: { url: string; className?: string }) {
  const t = useT();
  return (
    <a
      href={url}
      title={t("share", "openLink", { url })}
      onClick={(event) => {
        event.preventDefault();
        void openExternal(url, URL.canParse(url) ? new URL(url).host : url, t);
      }}
      className={className}
    >
      {url}
    </a>
  );
}

/** One publication, all taken from the same report at the same moment. */
interface Sent {
  target: string;
  report: string;
  logs: boolean;
  key: string;
  fileName: string;
  description: string;
  html: string;
}

/** The report as an object and a moment: two objects' files are two reports. */
function identityOf(report: Report | null): string {
  return report ? `${objectKey(report)}@${report.capturedAt}` : "";
}

function sentOf(
  report: Report | null,
  target: string,
  logs: boolean,
  html: string
): Sent | null {
  if (!report) return null;
  return {
    target,
    report: report.capturedAt,
    logs,
    key: objectKey(report),
    fileName: reportFileName(report),
    description: report.hero.ref
      ? `${report.subject.kind} ${report.subject.name}`
      : report.hero.title,
    html,
  };
}

/** What the dialog lists about a report: the part a reader consents to. */
function shapeOf(report: Report | null): string {
  if (!report) return "";
  return JSON.stringify([
    report.sections.map((section) => [
      section.id,
      section.count ?? null,
      section.unread ?? null,
      section.partial ?? null,
      section.body.type === "logs"
        ? section.body.logs.reduce((n, log) => n + log.lines.length, 0)
        : null,
    ]),
    report.notRead,
  ]);
}

/**
 * Saving is always here; publishing only where the reader configured a
 * target. Sending a cluster's names to a server is a decision, so it is
 * never the default: the target is picked by hand, and a public one has to
 * be acknowledged for this report, every time.
 */
export function ShareDialog({
  report,
  open,
  onOpenChange,
}: {
  report: Report | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { toast } = useToast();
  const copy = useCopyToClipboard();
  const [saving, setSaving] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [withLogs, setWithLogs] = useState(true);
  // The tick is consent to what the dialog shows going to one target: the
  // file as it was at the tick is kept beside it and is what goes out, so a
  // row that changes afterwards is not published unseen. Re-including the
  // logs, or a section that lands or grows, takes the tick away; a clock
  // ticking inside the file does not.
  const [ack, setAck] = useState<{
    target: string;
    shape: string;
    /** Which report, so another object's file of the same shape is not it. */
    report: string;
    sent: Sent;
  } | null>(null);
  // The link belongs to the capture, the target and whether the logs went
  // with it: a link to the version with logs is not the one on screen once
  // they are left out.
  const [published, setPublished] = useState<{
    target: string;
    report: string;
    logs: boolean;
    /** `null` when the target published it and named no link. */
    url: string | null;
  } | null>(null);

  const logLines = (report?.sections ?? []).reduce(
    (sum, section) =>
      section.body.type === "logs"
        ? sum + section.body.logs.reduce((n, log) => n + log.lines.length, 0)
        : sum,
    0
  );
  const shared = useMemo<Report | null>(
    () =>
      report && !withLogs && logLines > 0
        ? {
            ...report,
            sections: report.sections.map((section) =>
              section.body.type === "logs"
                ? {
                    ...section,
                    count: null,
                    body: {
                      type: "logs",
                      logs: [],
                      absent: t("share", "logsLeftOut"),
                    },
                  }
                : section
            ),
          }
        : report,
    [report, withLogs, logLines, t]
  );
  // Built when the report changes, not on every tick of the dialog: a list
  // report is hundreds of rows, and a checkbox is not a reason to redo them.
  const html = useMemo(() => (shared ? renderReport(shared) : ""), [shared]);
  const shape = useMemo(() => shapeOf(shared), [shared]);
  const targets = useQuery({
    queryKey: queryKeys.shareTargets(),
    queryFn: () => commands.listShareTargets(),
    enabled: open,
  });
  const target =
    (targets.data ?? []).find((entry) => entry.id === targetId) ?? null;

  const hasTargets = !targets.error && (targets.data ?? []).length > 0;
  const needsAck = target !== null && needsAcknowledgement(target);

  const acknowledged =
    ack !== null &&
    ack.target === (targetId ?? "") &&
    ack.shape === shape &&
    ack.report === identityOf(report);
  const logsGoing = withLogs && logLines > 0;
  const link =
    published !== null &&
    published.target === (targetId ?? "") &&
    published.report === (report?.capturedAt ?? "") &&
    published.logs === logsGoing
      ? published.url
      : null;

  // What the link is labelled with is what the request carried, not what the
  // dialog says when the answer arrives: a log toggle during the upload
  // must not relabel a link to the version with logs as one without.
  const publish = useMutation({
    mutationFn: async (sent: Sent) =>
      commands.publishReport(
        sent.target,
        sent.key,
        sent.fileName,
        sent.description,
        sent.html
      ),
    onSuccess: (answer, sent) => {
      const result = { ...answer, url: reportLink(answer.url) };
      setPublished({
        target: sent.target,
        report: sent.report,
        logs: sent.logs,
        url: result.url,
      });
      toast({
        title: t("share", "published", { n: result.version ?? 1 }),
        // The target's own address is not the report's link, and printing it
        // as one sent the reader to somebody else's index page.
        description: result.url ? (
          <WebLink url={result.url} className="text-info hover:underline" />
        ) : (
          t("share", "publishedNoLink")
        ),
      });
    },
    onError: (error) => toastError(t("share", "publishFailed"), error),
  });

  const handleSave = async () => {
    if (!report) return;
    setSaving(true);
    try {
      const destination = await save({ defaultPath: reportFileName(report) });
      if (!destination) return;
      await commands.writeTextFile(destination, html);
      onOpenChange(false);
      toast({
        title: t("share", "saved", { path: destination }),
      });
    } catch (error) {
      toastError(t("share", "saveFailed"), error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("share", "shareThis")}</DialogTitle>
          <DialogDescription>{t("share", "whatItCarries")}</DialogDescription>
        </DialogHeader>
        {report ? (
          <div className="flex flex-col gap-2 text-xs">
            <p className="text-fg-mut">{t("share", "preview")}</p>
            <ul
              className="flex flex-col gap-1 text-fg-mut"
              data-testid="share-preview"
            >
              {report.verdict ? (
                <li>
                  <span className="text-fg">
                    {t("share", "sectionVerdict")}
                  </span>{" "}
                  <span className="text-fg-fnt">{report.verdict}</span>
                </li>
              ) : null}
              {report.sections
                .filter((section) => section.body.type !== "logs")
                .map((section) => (
                  <li key={section.id}>
                    <span className="text-fg">{section.title}</span>{" "}
                    <span className="tabular-nums text-fg-fnt">
                      {section.unread ? "?" : (section.count ?? "")}
                    </span>
                  </li>
                ))}
              <li hidden={logLines === 0}>
                {logLines > 0 ? (
                  <label className="inline-flex items-center gap-2">
                    <Checkbox
                      checked={withLogs}
                      onCheckedChange={(value) => setWithLogs(value === true)}
                      aria-label={t("share", "includeLogs")}
                    />
                    <span className="text-fg">{t("share", "sectionLogs")}</span>
                    <span className="tabular-nums text-fg-fnt">
                      {withLogs ? logLines : 0}
                    </span>
                  </label>
                ) : null}
              </li>
              <li
                className={report.notRead.length > 0 ? "text-warn" : undefined}
              >
                <span className={report.notRead.length > 0 ? "" : "text-fg"}>
                  {t("share", "sectionNotRead")}
                </span>{" "}
                <span className="tabular-nums text-fg-fnt">
                  {report.notRead.length}
                </span>
              </li>
            </ul>
            <p className="text-[11px] text-fg-fnt">
              {t("share", "charactersLong", { n: html.length })} ·{" "}
              {shared && carriesLogLines(shared)
                ? t("share", "noSecretsLogs")
                : t("share", "noSecrets")}
            </p>
            <p
              className="truncate font-mono text-[11px] text-fg-fnt"
              title={report.link}
            >
              {report.link}
            </p>
          </div>
        ) : (
          <p className="text-xs text-fg-fnt">{t("share", "nothingToShare")}</p>
        )}
        {report && (targets.error || !hasTargets || needsAck || link) ? (
          <div className="flex flex-col gap-2 border-t border-hair pt-3 text-xs">
            {targets.error ? (
              // A list the app could not read is not a list with nothing in
              // it: "you have not added one yet" sends the reader to add a
              // target they already have.
              <p className="text-warn">
                {t("share", "targetsUnread", {
                  reason: errorToShow(targets.error),
                })}
              </p>
            ) : targets.isPending ? (
              <p className="text-fg-fnt">{t("share", "targetsReading")}</p>
            ) : !hasTargets ? (
              <p className="text-fg-fnt">{t("share", "noTargets")}</p>
            ) : null}
            {target && needsAck ? (
              <label className="flex items-start gap-2 rounded border border-err/40 bg-err/5 p-2 text-err">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(value) =>
                    setAck(() => {
                      const sent = sentOf(report, target.id, logsGoing, html);
                      return value === true && sent
                        ? {
                            target: target.id,
                            shape,
                            report: identityOf(report),
                            sent,
                          }
                        : null;
                    })
                  }
                  aria-label={t("share", "publicAcknowledge")}
                  className="mt-0.5"
                />
                <span>
                  {t("share", "publicWarning", { host: target.host })}{" "}
                  <span className="font-medium">
                    {t("share", "publicAcknowledge")}
                  </span>
                </span>
              </label>
            ) : null}
            {link ? (
              <div className="flex items-center gap-2">
                <WebLink
                  url={link}
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-info hover:underline"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copy(link, t("share", "copyLink"))}
                >
                  {t("share", "copyLink")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <DialogFooter className="sm:items-center">
          {report && hasTargets ? (
            <div className="flex min-w-0 items-center gap-2 text-xs sm:mr-auto">
              <Select
                value={targetId ?? ""}
                onValueChange={(value) => setTargetId(value)}
              >
                <SelectTrigger
                  aria-label={t("share", "target")}
                  className="h-7 w-56 text-xs"
                >
                  <SelectValue placeholder={t("share", "target")} />
                </SelectTrigger>
                <SelectContent>
                  {(targets.data ?? []).map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="h-2.5 w-[3px] rounded-sm"
                          style={{ background: targetColor(entry) }}
                        />
                        {entry.label}
                        <span className="font-mono text-[11px] text-fg-fnt">
                          {entry.host}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {target && !readyToPublish(target) ? (
                <span className="text-warn">{t("share", "targetNoKey")}</span>
              ) : null}
            </div>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          {target ? (
            <Button
              variant="outline"
              onClick={() => {
                const now = sentOf(report, target.id, logsGoing, html);
                const sent = needsAck ? (acknowledged ? ack.sent : null) : now;
                if (sent) publish.mutate(sent);
              }}
              disabled={
                !readyToPublish(target) ||
                publish.isPending ||
                (needsAck && !acknowledged)
              }
            >
              <Upload aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
              {publish.isPending
                ? t("share", "publishing")
                : t("share", "publishTo", { target: target.label })}
            </Button>
          ) : null}
          <Button onClick={handleSave} disabled={!report || saving}>
            <Download aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
            {t("share", "saveHtml")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
