import type { ReactNode } from "react";
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
  onConfirm: () => void;
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
  const gate = useCriticalGate();

  const handleOpenChange = (next: boolean) => {
    if (!next) gate.reset();
    onOpenChange(next);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
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
          <AlertDialogCancel>
            {cancelLabel ?? t("action", "cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: confirmVariant })}
            onClick={onConfirm}
            disabled={confirmDisabled || gate.blocked}
          >
            {confirmLabel ?? t("action", "confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
