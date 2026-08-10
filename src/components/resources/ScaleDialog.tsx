import { useState } from "react";
import { Link } from "react-router-dom";

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
import type { ScaleWarning } from "@/lib/governance";

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
  warnings?: ScaleWarning[];
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Scale {kind}</DialogTitle>
        </DialogHeader>
        {/* Radix drops the content when closed, so the field seeds itself from
            the live count on every opening without an effect to sync it. */}
        <ScaleWarnings warnings={warnings} />
        <ScaleForm
          current={current}
          busy={busy}
          confirmLabel={warnings.length > 0 ? "Scale anyway" : "Scale"}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One reason, or two, and the two do not read as two warnings.
 *
 * A workload with an autoscaler *and* a delivery controller is ordinary — an
 * HPA committed to git and applied by Argo — and stacking two paragraphs that
 * both begin "X will undo this" is how a dialog teaches somebody to click
 * through it. So the second shape is one sentence with two named causes under
 * it: the reader is told there are two, then which two, in the order they
 * will be felt. Each still says something the other does not — the autoscaler
 * replaces the number, the controller replaces the object and takes the
 * number with it.
 */
/** A small count in a sentence is a word. Past three there is no sentence. */
const COUNT_WORD: Record<number, string> = { 2: "Two", 3: "Three" };

function ScaleWarnings({ warnings }: { warnings: ScaleWarning[] }) {
  if (warnings.length === 0) return null;

  if (warnings.length === 1) {
    const only = warnings[0];
    return (
      <p className="text-xs text-fg-mut">
        <span className="font-medium text-warn">{only.lead}</span>{" "}
        {only.description}
        {only.to && (
          <>
            {" "}
            <Link to={only.to} className="text-info hover:underline">
              Open what delivers it
            </Link>
            .
          </>
        )}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-warn">
        {COUNT_WORD[warnings.length] ?? warnings.length} things will put this
        number back.
      </p>
      {warnings.map((warning) => (
        <p key={warning.key} className="text-xs text-fg-mut">
          <span className="text-fg">{warning.subject}</span> —{" "}
          {warning.description}
          {warning.to && (
            <>
              {" "}
              <Link to={warning.to} className="text-info hover:underline">
                Open it
              </Link>
              .
            </>
          )}
        </p>
      ))}
    </div>
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
          Cancel
        </Button>
        <Button onClick={() => onSubmit(replicas)} disabled={busy}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
