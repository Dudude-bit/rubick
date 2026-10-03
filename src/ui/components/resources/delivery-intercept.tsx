/**
 * The interception, at the point of action.
 *
 * **It does not block, it tells.** Scaling a delivered object by hand is a
 * legitimate thing to do in an incident and the app has no business refusing
 * it — a tool that argues with somebody at three in the morning gets closed.
 * What it has business doing is making sure nobody does it *believing it will
 * stick*, which is the actual failure: the replica count goes back three
 * minutes later, and the person who set it has already moved on.
 *
 * So the control keeps working. It only grows a step, and only where the
 * object is genuinely re-applied — a delivered object whose controller is
 * suspended, or in sync with self-heal off, gets no dialog at all, because
 * there is nothing to be wrong about.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DeliveryIntercept } from "@/lib/delivery";
import { deliveryWarning } from "@/lib/governance";
import { useCritical } from "@/hooks/useCritical";
import { useCriticalGate } from "@/hooks/useCriticalGate";
import { ActionWarnings } from "./action-warnings";
import { DetailAction, type DetailActionProps } from "./detail-blocks";
import { useT } from "@/i18n/useT";

/**
 * A {@link DetailAction} that asks first, and only when there is something to
 * ask about.
 *
 * With `intercept` null this was the control exactly as it was — same click,
 * same handler, no dialog. It still is on an ordinary cluster; on one the
 * person marked critical it grows the typed-name gate every other destructive
 * control here has, because "before any change" has to mean this control too —
 * a restart that fired on one click was the last way past the gate.
 */
export function InterceptedAction({
  intercept,
  onClick,
  label,
  ...props
}: DetailActionProps & { intercept: DeliveryIntercept | null }) {
  const [open, setOpen] = useState(false);
  const critical = useCritical();
  // A dialog is owed when a delivery controller would undo this, or when the
  // cluster is critical and so the gate must be typed first.
  const guarded =
    intercept !== null || (critical.critical && !!critical.context);

  return (
    <>
      <DetailAction
        {...props}
        label={label}
        onClick={() => (guarded ? setOpen(true) : onClick())}
      />
      <DeliveryInterceptDialog
        intercept={intercept}
        label={label}
        open={open}
        onOpenChange={setOpen}
        onConfirm={onClick}
      />
    </>
  );
}

export function DeliveryInterceptDialog({
  intercept,
  label,
  open,
  onOpenChange,
  onConfirm,
}: {
  intercept: DeliveryIntercept | null;
  /** The action verb, used to title the dialog when there is no intercept of
   *  its own to name it — the critical-cluster gate case. */
  label?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const gate = useCriticalGate();
  // Nothing to ask when neither a delivery controller owns this nor the cluster
  // is critical — the caller fires straight through in that case.
  if (!intercept && !gate.active) return null;

  const close = (next: boolean) => {
    if (!next) gate.reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{intercept?.title ?? label}</DialogTitle>
          {gate.notice}
        </DialogHeader>
        {intercept && <DeliveryInterceptBody intercept={intercept} />}
        {gate.input}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {t("action", "cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={gate.blocked}
            onClick={() => {
              close(false);
              onConfirm();
            }}
          >
            {intercept?.confirmLabel ?? label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The same sentence, for a dialog that already exists — Scale's, so far. */
export function DeliveryInterceptBody({
  intercept,
}: {
  intercept: DeliveryIntercept;
}) {
  return <ActionWarnings warnings={deliveryWarning(intercept)} />;
}
