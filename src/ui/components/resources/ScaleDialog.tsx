import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionWarning } from "@/lib/governance";
import { ActionWarnings } from "./action-warnings";
import { useCriticalGate } from "@/hooks/useCriticalGate";
import { useT } from "@/i18n/useT";

export interface ScaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Named in the title, so the reader knows what the number applies to. */
  kind: string;
  /** Where the field starts: the replica count the object has right now. */
  current: number;
  busy: boolean;
  onSubmit: (replicas: number) => void;
  /**
   * Everything that will move this number back, soonest first. The dialog
   * still scales — a warning changes the confirm word, not the outcome.
   */
  warnings?: ActionWarning[];
}

/** Set a workload's replica count. Shared by the detail page and the peek. */
export function ScaleDialog({
  open,
  onOpenChange,
  kind,
  current,
  busy,
  onSubmit,
  warnings = [],
}: ScaleDialogProps) {
  const t = useT();
  // Scaling a workload to zero on a cluster the person marked critical is a
  // change to that cluster, so the same typed-name gate the confirm dialogs
  // use guards the Scale button here too — notice and field cannot part ways.
  const gate = useCriticalGate();

  // The Scale button is a plain button, not a Radix close, so the success path
  // closes this by the parent flipping `open` — which never fires
  // onOpenChange. Reset on every close regardless of who closed it, or the
  // typed name survives a scale and the next one fires on a stale match.
  const gateReset = gate.reset;
  useEffect(() => {
    if (!open) gateReset();
  }, [open, gateReset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("action", "scaleKind", { kind })}</DialogTitle>
          {gate.notice}
        </DialogHeader>
        {/* Radix drops the content when closed, so the field seeds itself from
            the live count on every opening without an effect to sync it. */}
        <ActionWarnings warnings={warnings} headingFor="warnRevertCount" />
        <ScaleForm
          current={current}
          busy={busy}
          blocked={gate.blocked}
          gateInput={gate.input}
          confirmLabel={
            warnings.length > 0
              ? t("action", "scaleAnyway")
              : t("action", "scale")
          }
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

function ScaleForm({
  current,
  busy,
  blocked,
  gateInput,
  confirmLabel,
  onCancel,
  onSubmit,
}: {
  current: number;
  busy: boolean;
  /** True while the critical-cluster name has not been typed back. */
  blocked: boolean;
  /** The typed-name field, rendered next to the button it guards. */
  gateInput: ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onSubmit: (replicas: number) => void;
}) {
  const t = useT();
  const [replicas, setReplicas] = useState(current);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="replicas">{t("action", "replicasLabel")}</Label>
        <Input
          id="replicas"
          type="number"
          min={0}
          value={replicas}
          onChange={(event) =>
            setReplicas(parseInt(event.target.value, 10) || 0)
          }
        />
      </div>
      {gateInput}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("action", "cancel")}
        </Button>
        <Button onClick={() => onSubmit(replicas)} disabled={busy || blocked}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
