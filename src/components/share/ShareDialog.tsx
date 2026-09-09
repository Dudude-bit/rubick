import { useState } from "react";
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
import { normalizeTauriError } from "@/lib/error-utils";
import { renderReport, reportFileName, type Report } from "@/lib/report";
import {
  needsAcknowledgement,
  objectKey,
  targetColor,
} from "@/lib/share-targets";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useT } from "@/i18n/useT";

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
  // Both of these are about one report going to one target. Keeping what
  // they belong to beside them is what makes changing either take the tick
  // and the link away, without an effect that races the render.
  const [ack, setAck] = useState<{ target: string; report: string } | null>(
    null
  );
  const [published, setPublished] = useState<{
    target: string;
    report: string;
    url: string;
  } | null>(null);

  const html = report ? renderReport(report) : "";
  const targets = useQuery({
    queryKey: ["share-targets"],
    queryFn: () => commands.listShareTargets(),
    enabled: open,
  });
  const target =
    (targets.data ?? []).find((entry) => entry.id === targetId) ?? null;

  const belongsHere = (value: { target: string; report: string } | null) =>
    value !== null &&
    value.target === (targetId ?? "") &&
    value.report === (report?.capturedAt ?? "");
  const acknowledged = belongsHere(ack);
  const link = belongsHere(published) ? (published?.url ?? null) : null;

  const publish = useMutation({
    mutationFn: async () => {
      if (!report || !target) throw new Error("no target");
      return commands.publishReport(
        target.id,
        objectKey(report.subject),
        reportFileName(report),
        `${report.subject.kind} ${report.subject.name}`,
        html
      );
    },
    onSuccess: (result) => {
      setPublished({
        target: targetId ?? "",
        report: report?.capturedAt ?? "",
        url: result.url,
      });
      toast({
        title: t("share", "published", { n: result.version ?? 1 }),
        description: result.url,
      });
    },
    onError: (error) =>
      toast({
        title: t("share", "publishFailed"),
        description: normalizeTauriError(error),
        variant: "destructive",
      }),
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
      toast({
        title: t("share", "saveFailed"),
        description: normalizeTauriError(error),
        variant: "destructive",
      });
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
              <li>
                <span className="text-fg">{t("share", "sectionVerdict")}</span>{" "}
                <span className="text-fg-fnt">
                  {report.verdict ?? t("share", "nothingHere")}
                </span>
              </li>
              <li>
                <span className="text-fg">{t("share", "sectionFacts")}</span>{" "}
                <span className="text-fg-fnt">{report.facts.length}</span>
              </li>
              <li>
                <span className="text-fg">{t("share", "sectionChain")}</span>{" "}
                <span className="text-fg-fnt">{report.chain.length}</span>
              </li>
              <li>
                <span className="text-fg">{t("share", "sectionChanges")}</span>{" "}
                <span className="text-fg-fnt">{report.changes.length}</span>
              </li>
              <li>
                <span className="text-fg">{t("share", "sectionLogs")}</span>{" "}
                <span className="text-fg-fnt">
                  {report.logs.reduce((sum, log) => sum + log.lines.length, 0)}
                </span>
              </li>
              <li
                className={report.notRead.length > 0 ? "text-warn" : undefined}
              >
                <span className={report.notRead.length > 0 ? "" : "text-fg"}>
                  {t("share", "sectionNotRead")}
                </span>{" "}
                <span className="text-fg-fnt">{report.notRead.length}</span>
              </li>
            </ul>
            <p className="text-[11px] text-fg-fnt">
              {t("share", "charactersLong", { n: html.length })} ·{" "}
              {t("share", "noSecrets")}
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
        {report ? (
          <div className="flex flex-col gap-2 border-t border-hair pt-3 text-xs">
            {(targets.data ?? []).length === 0 ? (
              <p className="text-fg-fnt">{t("share", "noTargets")}</p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Select
                    value={targetId ?? ""}
                    onValueChange={(value) => setTargetId(value)}
                  >
                    <SelectTrigger
                      aria-label={t("share", "target")}
                      className="h-7 w-64 text-xs"
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
                  {target && !target.hasKey ? (
                    <span className="text-warn">
                      {t("share", "targetNoKey")}
                    </span>
                  ) : null}
                </div>
                {target && needsAcknowledgement(target) ? (
                  <label className="flex items-start gap-2 rounded border border-err/40 bg-err/5 p-2 text-err">
                    <Checkbox
                      checked={acknowledged}
                      onCheckedChange={(value) =>
                        setAck(
                          value === true
                            ? { target: target.id, report: report.capturedAt }
                            : null
                        )
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
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-info">
                      {link}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copy(link, t("share", "copyLink"))}
                    >
                      {t("share", "copyLink")}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          {target ? (
            <Button
              variant="outline"
              onClick={() => publish.mutate()}
              disabled={
                !target.hasKey ||
                publish.isPending ||
                (needsAcknowledgement(target) && !acknowledged)
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
