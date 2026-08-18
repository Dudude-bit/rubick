import { useState } from "react";

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scale {kind}</DialogTitle>
        </DialogHeader>
        {/* Radix drops the content when closed, so the field seeds itself from
            the live count on every opening without an effect to sync it. */}
        <ActionWarnings
          warnings={warnings}
          headingFor={(count) => `${count} things will put this number back.`}
        />
        <ScaleForm
          current={current}
          busy={busy}
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
  confirmLabel,
  onCancel,
  onSubmit,
}: {
  current: number;
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onSubmit: (replicas: number) => void;
}) {
  const t = useT();
  const [replicas, setReplicas] = useState(current);

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="replicas">Number of replicas</Label>
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
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("action", "cancel")}
        </Button>
        <Button onClick={() => onSubmit(replicas)} disabled={busy}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
