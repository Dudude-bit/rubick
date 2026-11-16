import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCriticalGate } from "@/hooks/useCriticalGate";
import { Eyebrow } from "@/components/ui/states";
import { useT } from "@/i18n/useT";
import { comparisonOf, type Revision } from "@/lib/changes";
import type { DeliveryIntercept } from "@/lib/delivery";
import { Against } from "../-changes/ChangesTimeline";
import { DeliveryInterceptBody } from "../-delivery/delivery-intercept";

export interface RollbackSubject {
  kind: "Deployment" | "StatefulSet" | "DaemonSet";
  name: string;
  namespace: string;
}

export function RollbackDialog({
  subject,
  target,
  current,
  intercept,
  busy,
  onOpenChange,
  onConfirm,
}: {
  subject: RollbackSubject;
  target: Revision;
  current: Revision | undefined;
  intercept: DeliveryIntercept | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const gate = useCriticalGate(true);
  const label = `${subject.kind} ${subject.namespace}/${subject.name}`;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || gate.blocked) return;
            onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("action", "rollbackTitle", {
                subject: label,
                n: target.number ?? "",
              })}
            </DialogTitle>
            {gate.notice}
            <DialogDescription className="text-xs">
              {t("action", "rollbackBody", { n: target.number ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div data-testid="rollback-changes">
            <Eyebrow>{t("action", "rollbackWhatChanges")}</Eyebrow>
            {current ? (
              <Against against={comparisonOf(current, target)} />
            ) : (
              <p className="text-caption text-warn">
                {t("action", "rollbackCurrentUnknown")}
              </p>
            )}
          </div>
          {intercept && <DeliveryInterceptBody intercept={intercept} />}
          {gate.input}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              data-autofocus
            >
              {t("action", "cancel")}
            </Button>
            <Button type="submit" pending={busy} disabled={gate.blocked}>
              {intercept?.confirmLabel ?? t("action", "rollBack")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
