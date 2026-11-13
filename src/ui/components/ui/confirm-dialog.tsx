import { useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useCriticalGate } from "@/hooks/useCriticalGate";
import { useT } from "@/i18n/useT";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive";
  confirmDisabled?: boolean;
  /**
   * What the reader has to fill in before confirming — a name, a count.
   *
   * Sits between the description and the buttons. Most confirmations need
   * none; the ones that do were otherwise a second dialog component with the
   * same two buttons drawn again slightly differently.
   */
  children?: ReactNode;
  onOpenChange: (open: boolean) => void;
  /** A promise keeps the dialog open and pending until it settles; it closes only on success. */
  onConfirm: () => unknown;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmVariant = "default",
  confirmDisabled = false,
  children,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useT();
  // On critical infrastructure the reader also types the cluster's name:
  // what this guards against is not the object but the window it is in.
  const gate = useCriticalGate(open);
  const [pending, setPending] = useState(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {gate.notice}
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        {gate.input}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {cancelLabel ?? t("action", "cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: confirmVariant })}
            onClick={(event) => {
              const result = onConfirm();
              if (!(result instanceof Promise)) return;
              event.preventDefault();
              setPending(true);
              result
                .then(
                  () => onOpenChange(false),
                  () => undefined
                )
                .finally(() => setPending(false));
            }}
            disabled={confirmDisabled || gate.blocked || pending}
            aria-busy={pending || undefined}
          >
            {pending && (
              <Spinner size="xs" aria-hidden="true" className="mr-1.5" />
            )}
            {confirmLabel ?? t("action", "confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
