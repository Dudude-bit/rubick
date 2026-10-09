import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

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
import { AutoscalerBounds } from "./AutoscalerBounds";
import { useCriticalGate } from "@/hooks/useCriticalGate";
import { useT } from "@/i18n/useT";
import { qualified } from "../-peek/peek-actions";

export interface ScaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Named in the title, so the reader knows what the number applies to. */
  kind: string;
  name: string;
  namespace: string | null;
  /** Where the field starts: the replica count, undefined until it is read. */
  current: number | undefined;
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
  name,
  namespace,
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
  const count = useRef<HTMLInputElement>(null);
  // A count read after the dialog opened remounts the field, which drops the
  // focus it held.
  const claimFocus = useCallback((input: HTMLInputElement | null) => {
    count.current = input;
    if (
      !input ||
      input.closest("[role=dialog]")?.contains(document.activeElement)
    )
      return;
    focusCount(input);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Opened from a menu, the menu's focus trap takes the count's focus
        // back while this mounts, and Radix then focuses the first field.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusCount(count.current);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("action", "scaleKind", {
              kind,
              name: qualified(name, namespace),
            })}
          </DialogTitle>
          {gate.notice}
        </DialogHeader>
        {/* Radix drops the content when closed, so the field seeds itself from
            the live count on every opening without an effect to sync it. */}
        <ActionWarnings warnings={warnings} headingFor="warnRevertCount" />
        {warnings.map(
          (warning) =>
            warning.autoscaler && (
              <AutoscalerBounds
                key={warning.key}
                autoscaler={warning.autoscaler}
                blocked={gate.blocked}
              />
            )
        )}
        <ScaleForm
          key={current === undefined ? "unread" : "read"}
          countRef={claimFocus}
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

function focusCount(input: HTMLInputElement | null) {
  input?.focus();
  input?.select();
}

function ScaleForm({
  countRef,
  current,
  busy,
  blocked,
  gateInput,
  confirmLabel,
  onCancel,
  onSubmit,
}: {
  countRef: Ref<HTMLInputElement>;
  current: number | undefined;
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
  const [typed, setTyped] = useState(
    current === undefined ? "" : String(current)
  );
  const replicas = typed.trim() === "" ? null : Number(typed);
  const counted =
    replicas !== null && Number.isInteger(replicas) && replicas >= 0;
  // A form, so Enter scales as the button does; a disabled submit button
  // holds Enter back too.
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)] gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (counted) onSubmit(replicas);
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="replicas">{t("action", "replicasLabel")}</Label>
        <Input
          ref={countRef}
          id="replicas"
          type="number"
          min={0}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        {!counted && (
          <p className="text-[11px] text-fg-mut">
            {current === undefined && typed === ""
              ? t("action", "scaleCountUnread")
              : t("action", "scaleNeedsCount")}
          </p>
        )}
      </div>
      {gateInput}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t("action", "cancel")}
        </Button>
        <Button type="submit" disabled={busy || blocked || !counted}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
