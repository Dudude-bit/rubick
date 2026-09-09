import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { useT } from "@/i18n/useT";

/**
 * Saving is the whole of it, on purpose. Publishing a report puts a cluster's
 * names on somebody else's server, and that is a decision with its own screen
 * rather than a second button beside this one.
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
  const [saving, setSaving] = useState(false);

  const html = report ? renderReport(report) : "";

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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action", "cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!report || saving}>
            <Download aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
            {t("share", "saveHtml")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
