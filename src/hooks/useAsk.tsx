import { useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ASK_OF,
  isOpen,
  MAX_WATCHES_PER_CLUSTER,
  OUTCOME_DEADLINE_MS,
  type After,
  type Watch,
  type WatchKind,
} from "@/lib/tell-me-when";
import { useClusterStore } from "@/stores/clusterStore";
import { useTellMeWhenStore } from "@/stores/tellMeWhenStore";
import { useT } from "@/i18n/useT";

export interface AskTarget {
  kind: WatchKind;
  namespace: string | null;
  name: string;
  sessionId?: string;
  crd?: Watch["crd"];
}

/**
 * The one way a "tell me when" is started, from any surface.
 *
 * Adding past the cap opens a dialog listing what is being watched and asks
 * which to give up; nothing is dropped on the person's behalf. `dialog` is
 * mounted by the caller beside its other dialogs.
 */
export function useAsk(): {
  ask: (target: AskTarget, after?: After) => void;
  stop: (target: AskTarget) => void;
  watching: (target: AskTarget) => boolean;
  dialog: ReactNode;
} {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const watches = useTellMeWhenStore((s) => s.watches);
  const add = useTellMeWhenStore((s) => s.add);
  const replace = useTellMeWhenStore((s) => s.replace);
  const remove = useTellMeWhenStore((s) => s.remove);
  const [pending, setPending] = useState<Watch | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const find = (target: AskTarget) =>
    watches.find(
      (w) =>
        w.context === context &&
        w.kind === target.kind &&
        w.namespace === target.namespace &&
        w.name === target.name &&
        w.sessionId === target.sessionId &&
        isOpen(w)
    );

  const ask = (target: AskTarget, after?: After) => {
    if (!context) return;
    // An action already being followed is followed afresh: the new click is
    // the one whose outcome the reader wants, and the old baseline is stale.
    if (after) {
      const stale = find(target);
      if (stale) remove(stale.id);
    }
    const watch: Watch = {
      id: crypto.randomUUID(),
      context,
      kind: target.kind,
      namespace: target.namespace,
      name: target.name,
      ask: ASK_OF[target.kind],
      startedAt: Date.now(),
      status: { state: "watching" },
      baseline: null,
      sessionId: target.sessionId,
      crd: target.crd,
      after: after ?? null,
      deadline: after ? Date.now() + OUTCOME_DEADLINE_MS : null,
    };
    if (add(watch) === "full") {
      setPending(watch);
      setDropId(null);
    }
  };

  const stop = (target: AskTarget) => {
    const found = find(target);
    if (found) remove(found.id);
  };

  const open = watches.filter((w) => w.context === context && isOpen(w));

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={t("tell", "full", { max: MAX_WATCHES_PER_CLUSTER })}
      description={t("tell", "fullBody")}
      confirmLabel={t("tell", "swap")}
      cancelLabel={t("tell", "keepAll")}
      confirmDisabled={dropId === null}
      onOpenChange={(next) => {
        if (!next) setPending(null);
      }}
      onConfirm={() => {
        if (pending && dropId) replace(dropId, pending);
        setPending(null);
      }}
    >
      <RadioGroup
        value={dropId ?? ""}
        onValueChange={setDropId}
        className="max-h-[280px] overflow-auto"
      >
        {open.map((w) => (
          <label
            key={w.id}
            className="flex cursor-pointer items-center gap-2 py-1 text-xs"
          >
            <RadioGroupItem value={w.id} />
            <span className="truncate font-mono">
              {w.kind} · {w.namespace ? `${w.namespace}/` : ""}
              {w.name}
            </span>
          </label>
        ))}
      </RadioGroup>
    </ConfirmDialog>
  );

  return {
    ask,
    stop,
    watching: (target) => find(target) !== undefined,
    dialog,
  };
}
