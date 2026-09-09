import { useCallback, useId, useState, type ReactNode } from "react";

import { CriticalNotice } from "@/components/ui/critical-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCritical } from "@/hooks/useCritical";
import { useT } from "@/i18n/useT";

/**
 * The one place the critical-cluster typed-name gate lives.
 *
 * Every destructive dialog on a cluster the person marked critical asks for
 * the cluster's own name before it fires. The check is one line, but it was
 * copied into two dialogs and forgotten in the rest — so scale-to-zero, a
 * YAML apply and a node drain showed the red "type the name" notice and then
 * went ahead on one click. This hook is that notice AND the field it promises,
 * together, so a dialog cannot render the one without the other:
 *
 *   const gate = useCriticalGate();
 *   ... {gate.notice} ... {gate.input} ...
 *   <Button disabled={busy || gate.blocked} />
 *   // and gate.reset() when the dialog closes.
 */
export function useCriticalGate(): {
  /** The cluster is marked critical, so the gate applies at all. A caller that
   *  otherwise fires with no dialog (an InterceptedAction with no delivery to
   *  warn about) uses this to decide it must interpose one after all. */
  active: boolean;
  /** True while the action must stay disabled: marked critical and the typed
   *  name does not match yet. False on a cluster that is not critical. */
  blocked: boolean;
  /** The red band, or null when the cluster is not critical. */
  notice: ReactNode;
  /** The label + typed-name field, or null when not critical. */
  input: ReactNode;
  /** Clear the typed name — call when the dialog closes. */
  reset: () => void;
} {
  const t = useT();
  const critical = useCritical();
  const [typed, setTyped] = useState("");
  const id = useId();
  const gate = critical.critical ? critical.context : null;
  const blocked = gate !== null && typed !== gate;
  // Stable so a callback that clears the gate on close (a useCallback apply
  // handler, say) does not churn its identity every render.
  const reset = useCallback(() => setTyped(""), []);

  return {
    active: gate !== null,
    blocked,
    notice: gate ? <CriticalNotice context={gate} /> : null,
    input: gate ? (
      <div className="space-y-2">
        <Label htmlFor={id} className="text-sm">
          {t("action", "typeWord")}{" "}
          <code className="rounded bg-err/16 px-1.5 py-0.5 font-mono text-xs text-err">
            {gate}
          </code>{" "}
          {t("action", "toConfirm")}
        </Label>
        <Input
          id={id}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={gate}
          autoComplete="off"
        />
      </div>
    ) : null,
    reset,
  };
}
