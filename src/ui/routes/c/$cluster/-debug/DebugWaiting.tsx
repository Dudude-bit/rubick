import type { ReactNode } from "react";
import { AlertTriangle, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n/useT";
import { formatTimeUnit } from "@/lib/utils";

/** The dialog both debug flows show while the cluster brings the container up. */
export function DebugPolling({
  open,
  onOpenChange,
  title,
  description,
  statusReason,
  elapsedSeconds,
  timeoutSeconds,
  progressPercent,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  statusReason: string | null | undefined;
  elapsedSeconds: number;
  timeoutSeconds: number;
  progressPercent: number;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Spinner size="sm" className="text-fg-fnt" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 border-t border-hair pt-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-fg-mut">{t("columns", "status")}</span>
            <span className="font-mono text-fg">
              {statusReason || t("action", "initializing")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-mut">{t("action", "elapsed")}</span>
            <span className="font-mono text-fg">
              {formatTimeUnit(elapsedSeconds, "second")}{" "}
              <span className="text-fg-fnt">/</span>{" "}
              {formatTimeUnit(timeoutSeconds, "second")}
            </span>
          </div>
          <Progress value={progressPercent} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("action", "cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog both debug flows show when the container did not come up in
 * time. Deleting is the one action that writes, so while it runs every
 * button is held: a second press would send the delete twice.
 */
export function DebugNotReady({
  open,
  title,
  description,
  statusReason,
  deleting,
  onLeave,
  onDelete,
  onKeepWaiting,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  statusReason: string | null | undefined;
  deleting: boolean;
  onLeave: () => void;
  onDelete: () => void;
  onKeepWaiting: () => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warn" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {statusReason && (
          <div className="flex items-center gap-2 border-t border-hair pt-2 text-xs">
            <Clock
              className="h-3.5 w-3.5 flex-none text-fg-fnt"
              aria-hidden="true"
            />
            <span className="text-fg-mut">{t("action", "lastStatus")}</span>
            <span className="ml-auto font-mono text-fg">{statusReason}</span>
          </div>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={onLeave} disabled={deleting}>
            {t("action", "leave")}
          </Button>
          <Button variant="destructive" onClick={onDelete} pending={deleting}>
            {t("action", "deletePod")}
          </Button>
          <Button onClick={onKeepWaiting} disabled={deleting}>
            {t("action", "keepWaiting")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
