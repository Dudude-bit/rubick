import { RotateCcw } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DetailAction } from "@/components/resources/detail-blocks";
import type { HelmRelease, HelmRevision } from "@/generated/types";
import { statusRole } from "@/lib/status-role";
import { cn, formatDate } from "@/lib/utils";
import { useT } from "@/i18n/useT";

interface HelmHistoryDialogProps {
  release: HelmRelease;
  history: HelmRevision[];
  isLoading: boolean;
  helmCliAvailable: boolean;
  onClose: () => void;
  onRollback: (revision: number) => void;
}

export function HelmHistoryDialog({
  release,
  history,
  isLoading,
  helmCliAvailable,
  onClose,
  onRollback,
}: HelmHistoryDialogProps) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {t("action", "history")}
            <span className="ml-2 font-mono text-[11px] font-normal text-fg-fnt">
              {release.namespace}/{release.name}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <p className="py-6 text-center text-xs text-fg-fnt">
              {t("empty", "readingHistory")}
            </p>
          ) : history.length === 0 ? (
            <p className="py-6 text-center text-xs text-fg-fnt">
              {t("empty", "noHelmHistory")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns", "rev")}</TableHead>
                  <TableHead>{t("columns", "status")}</TableHead>
                  <TableHead>Chart</TableHead>
                  <TableHead>{t("columns", "updated")}</TableHead>
                  <TableHead>{t("columns", "description")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((rev) => {
                  const current = rev.revision === release.revision;
                  return (
                    <TableRow
                      key={rev.revision}
                      className={cn(current && "bg-sel")}
                      data-quiet={current || undefined}
                    >
                      <TableCell className="font-mono text-fg">
                        {rev.revision}
                        {current && (
                          <span className="ml-1.5 text-[11px] text-fg-fnt">
                            current
                          </span>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-[11px]",
                          statusRole(rev.status) === "err"
                            ? "text-err"
                            : "text-fg-mut"
                        )}
                      >
                        {rev.status}
                      </TableCell>
                      <TableCell className="font-mono text-fg-mut">
                        {rev.chart}
                      </TableCell>
                      <TableCell className="text-fg-fnt">
                        {formatDate(rev.updated) ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate text-fg-fnt">
                        {rev.description || "—"}
                      </TableCell>
                      <TableCell>
                        <span className="flex justify-end">
                          {!current && helmCliAvailable && (
                            <DetailAction
                              label={t("action", "rollBack")}
                              icon={RotateCcw}
                              onClick={() => onRollback(rev.revision)}
                            />
                          )}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
