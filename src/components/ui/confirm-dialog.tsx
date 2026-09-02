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
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>
            {cancelLabel ?? t("action", "cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: confirmVariant })}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel ?? t("action", "confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
