import { useState } from "react";
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
import { CriticalNotice } from "@/components/ui/critical-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { useCritical } from "@/hooks/useCritical";
import { useT } from "@/i18n/useT";

interface DangerousConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** The text that user must type to confirm the action */
  confirmationText: string;
  /** Placeholder text for the input field */
  confirmationPlaceholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isLoading?: boolean;
}

export function DangerousConfirmDialog({
  open,
  title,
  description,
  confirmationText,
  confirmationPlaceholder,
  confirmLabel,
  cancelLabel,
  onOpenChange,
  onConfirm,
  isLoading = false,
}: DangerousConfirmDialogProps) {
  const t = useT();
  const [inputValue, setInputValue] = useState("");
  // On critical infrastructure the word to type is the cluster's, not the
  // object's: the mistake this guards against is the cluster, and typing a
  // pod's name proves nothing about which cluster the pod is on.
  const critical = useCritical();
  const expected =
    critical.critical && critical.context ? critical.context : confirmationText;

  const isConfirmEnabled = inputValue === expected && !isLoading;

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setInputValue("");
    }
    onOpenChange(newOpen);
  };

  const handleConfirm = () => {
    if (isConfirmEnabled) {
      onConfirm();
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {critical.critical && critical.context && (
            <CriticalNotice context={critical.context} />
          )}
          <AlertDialogDescription className={description ? "" : "sr-only"}>
            {description || t("action", "confirmByTyping")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="py-4 space-y-2">
          <Label htmlFor="confirmation-input" className="text-sm">
            {t("action", "typeWord")}{" "}
            <code className="rounded bg-err/16 px-1.5 py-0.5 font-mono text-xs text-err">
              {expected}
            </code>{" "}
            {t("action", "toConfirm")}
          </Label>
          <Input
            id="confirmation-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={confirmationPlaceholder ?? expected}
            autoComplete="off"
            autoFocus
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel ?? t("action", "cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={handleConfirm}
            disabled={!isConfirmEnabled}
          >
            {isLoading
              ? t("action", "processing")
              : (confirmLabel ?? t("action", "confirm"))}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
