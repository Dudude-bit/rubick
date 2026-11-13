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
import { CriticalNotice } from "@/components/ui/critical-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { WriteFailure } from "@/components/ui/write-failure";
import { holdWriteToasts } from "@/lib/write-hold";
import { useCritical } from "@/hooks/useCritical";
import { useT } from "@/i18n/useT";

interface DangerousConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** What else the action does, worked out while the dialog is open. */
  details?: ReactNode;
  /** The text that user must type to confirm the action */
  confirmationText: string;
  /** Placeholder text for the input field */
  confirmationPlaceholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onOpenChange: (open: boolean) => void;
  /** A promise keeps the dialog open and pending until it settles; it closes only on success. */
  onConfirm: () => unknown;
  isLoading?: boolean;
}

export function DangerousConfirmDialog({
  open,
  title,
  description,
  details,
  confirmationText,
  confirmationPlaceholder,
  confirmLabel,
  cancelLabel,
  onOpenChange,
  onConfirm,
  isLoading: loadingFromCaller = false,
}: DangerousConfirmDialogProps) {
  const t = useT();
  const [inputValue, setInputValue] = useState("");
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const isLoading = loadingFromCaller || running;
  // Forgotten whenever the dialog is closed, whoever closed it: a caller that
  // flips `open` after a success fires no onOpenChange.
  if (!open && inputValue !== "") setInputValue("");
  if (!open && failure !== null) setFailure(null);
  // On critical infrastructure the word to type is the cluster's, not the
  // object's: the mistake this guards against is the cluster, and typing a
  // pod's name proves nothing about which cluster the pod is on.
  const critical = useCritical();
  const expected =
    critical.critical && critical.context ? critical.context : confirmationText;

  const isConfirmEnabled = inputValue === expected && !isLoading;

  const handleConfirm = (event?: { preventDefault: () => void }) => {
    if (!isConfirmEnabled) return;
    const release = holdWriteToasts();
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      release();
      if (!event) onOpenChange(false);
      return;
    }
    event?.preventDefault();
    setRunning(true);
    setFailure(null);
    result
      .then(
        () => onOpenChange(false),
        (error: unknown) => setFailure(error ?? "")
      )
      .finally(() => {
        release();
        setRunning(false);
      });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!isLoading) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {critical.critical && critical.context && (
            <CriticalNotice context={critical.context} />
          )}
          <AlertDialogDescription className={description ? "" : "sr-only"}>
            {description || t("action", "confirmByTyping")}
          </AlertDialogDescription>
          {details && (
            <div
              data-testid="confirm-details"
              className="max-h-[40vh] min-h-0 overflow-y-auto scrollbar-lane"
            >
              {details}
            </div>
          )}
        </AlertDialogHeader>

        <div className="py-4 space-y-2">
          <Label htmlFor="confirmation-input" className="text-xs">
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
            placeholder={confirmationPlaceholder}
            autoComplete="off"
            data-autofocus
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !isConfirmEnabled) return;
              event.preventDefault();
              handleConfirm();
            }}
          />
          {failure !== null && <WriteFailure error={failure} />}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel ?? t("action", "cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={handleConfirm}
            disabled={!isConfirmEnabled}
            aria-busy={isLoading || undefined}
          >
            {isLoading && (
              <Spinner size="xs" aria-hidden="true" className="mr-1.5" />
            )}
            {confirmLabel ?? t("action", "confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
