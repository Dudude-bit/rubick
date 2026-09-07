import { useState } from "react";
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
import { CriticalNotice } from "@/components/ui/critical-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCritical } from "@/hooks/useCritical";
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
  const critical = useCritical();
  const [typed, setTyped] = useState("");
  // On critical infrastructure the reader also types the cluster's name:
  // what this guards against is not the object but the window it is in.
  const gate = critical.critical ? critical.context : null;
  const gated = gate !== null && typed !== gate;

  const handleOpenChange = (next: boolean) => {
    if (!next) setTyped("");
    onOpenChange(next);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {gate && <CriticalNotice context={gate} />}
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        {gate && (
          <div className="space-y-2">
            <Label htmlFor="critical-context-input" className="text-sm">
              {t("action", "typeWord")}{" "}
              <code className="rounded bg-err/16 px-1.5 py-0.5 font-mono text-xs text-err">
                {gate}
              </code>{" "}
              {t("action", "toConfirm")}
            </Label>
            <Input
              id="critical-context-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={gate}
              autoComplete="off"
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>
            {cancelLabel ?? t("action", "cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: confirmVariant })}
            onClick={onConfirm}
            disabled={confirmDisabled || gated}
          >
            {confirmLabel ?? t("action", "confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
