import { useRef } from "react";

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
  const gate = useCriticalGate();
  const confirm = useRef<HTMLButtonElement>(null);
  const label = `${subject.kind.toLowerCase()} ${subject.namespace}/${subject.name}`;

  const close = (next: boolean) => {
    if (!next) gate.reset();
    onOpenChange(next);
  };

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          if (gate.active) return;
          event.preventDefault();
          confirm.current?.focus();
        }}
      >
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
            <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-fg-fnt">
              {t("action", "rollbackWhatChanges")}
            </p>
            {current ? (
              <Against against={comparisonOf(current, target)} />
            ) : (
              <p className="text-[11px] text-warn">
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
              onClick={() => close(false)}
            >
              {t("action", "cancel")}
            </Button>
            <Button ref={confirm} type="submit" disabled={busy || gate.blocked}>
              {intercept?.confirmLabel ?? t("action", "rollBack")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
