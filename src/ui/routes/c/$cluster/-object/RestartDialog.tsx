import { useRef, useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ReasonedAction } from "@/components/object/detail-blocks";
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
import type { DeliveryIntercept } from "@/lib/delivery";
import { restartWords } from "@/lib/restart-plan";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { RolloutPlan } from "@/generated/types";
import { DeliveryInterceptBody } from "../-delivery/delivery-intercept";
import { qualified } from "../-peek/peek-actions";
import { guardedOf, noteDenied, useDenied } from "./access";

export interface RestartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: string;
  name: string;
  namespace: string | null;
  /** Undefined until the workload is read; the dialog then says the general case. */
  plan: RolloutPlan | undefined;
  intercept: DeliveryIntercept | null;
  busy: boolean;
  onConfirm: () => void;
}

/**
 * A rolling restart, asked once with what it will do in numbers. No typed
 * name: that is Delete's, and a restart is undone by the next one. The
 * confirm button holds focus so Enter restarts and Escape does not.
 */
export function RestartDialog({
  open,
  onOpenChange,
  kind,
  name,
  namespace,
  plan,
  intercept,
  busy,
  onConfirm,
}: RestartDialogProps) {
  const t = useT();
  const gate = useCriticalGate();
  const confirm = useRef<HTMLButtonElement>(null);
  const words = restartWords(plan, name, t);
  const subject = `${kind} ${qualified(name, namespace)}`;

  const close = (next: boolean) => {
    if (!next) gate.reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
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
              {t("action", "restartSubjectTitle", { subject })}
            </DialogTitle>
            {gate.notice}
            <DialogDescription
              className={cn(
                "flex items-baseline gap-1.5 text-xs",
                TONE_TEXT[words.tone]
              )}
            >
              <RefreshCw
                className="h-3 w-3 flex-none self-center"
                aria-hidden="true"
              />
              <span data-testid="restart-plan">{words.text}</span>
            </DialogDescription>
          </DialogHeader>
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
              {intercept?.confirmLabel ?? t("action", "restart")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A detail page's Restart: the button and the dialog it opens. Nothing
 * restarts on the click itself.
 */
export function RestartAction({
  mutation,
  ...dialog
}: Omit<RestartDialogProps, "open" | "onOpenChange" | "busy" | "onConfirm"> & {
  mutation: UseMutationResult<void, Error, void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const guarded = guardedOf(dialog.kind, dialog.namespace);
  const denied = useDenied(guarded).patch;
  return (
    <>
      <ReasonedAction
        label={t("action", "restart")}
        icon={RefreshCw}
        onClick={() => setOpen(true)}
        busy={mutation.isPending}
        reason={denied}
      />
      <RestartDialog
        {...dialog}
        open={open}
        onOpenChange={setOpen}
        busy={mutation.isPending}
        onConfirm={() =>
          mutation.mutate(undefined, {
            onSuccess: () => setOpen(false),
            onError: (error) => noteDenied("patch", guarded, error),
          })
        }
      />
    </>
  );
}
