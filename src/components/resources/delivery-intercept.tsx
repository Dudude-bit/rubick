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
import { ActionWarnings } from "./action-warnings";
import { DetailAction, type DetailActionProps } from "./detail-blocks";

/**
 * A {@link DetailAction} that asks first, and only when there is something to
 * ask about.
 *
 * With `intercept` null this is the control exactly as it was — same click,
 * same handler, no dialog — which is what every object on a cluster with no
 * delivery controller gets.
 */
export function InterceptedAction({
  intercept,
  onClick,
  label,
  ...props
}: DetailActionProps & { intercept: DeliveryIntercept | null }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <DetailAction
        {...props}
        label={label}
        onClick={() => (intercept ? setOpen(true) : onClick())}
      />
      <DeliveryInterceptDialog
        intercept={intercept}
        open={open}
        onOpenChange={setOpen}
        onConfirm={onClick}
      />
    </>
  );
}

export function DeliveryInterceptDialog({
  intercept,
  open,
  onOpenChange,
  onConfirm,
}: {
  intercept: DeliveryIntercept | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  if (!intercept) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{intercept.title}</DialogTitle>
        </DialogHeader>
        <DeliveryInterceptBody intercept={intercept} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {intercept.confirmLabel}
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
