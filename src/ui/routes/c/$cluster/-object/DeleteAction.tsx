import type { UseMutationResult } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import {
  describeDeletion,
  describePodRestart,
  podRestartAction,
  warned,
} from "../-peek/peek-actions";
import { CascadePreview } from "./CascadePreview";
import type { ServedResource } from "./served";
import { ReasonedAction } from "@/components/object/detail-blocks";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import type { DeliveryIntercept } from "@/lib/delivery";
import type { PodInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { guardedOf, noteDenied, useDenied, type Guarded } from "./access";

/**
 * The one confirmation for taking an object away: the name typed, what a
 * delivery controller will do about it, what replaces it and what goes with
 * it. A pod's restart is a deletion, so it asks here too.
 */
export function DeletionDialog({
  open,
  onOpenChange,
  kind,
  name,
  namespace,
  detail,
  intercept,
  served,
  restart = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: string;
  name: string;
  namespace?: string | null;
  detail?: unknown;
  intercept: DeliveryIntercept | null;
  served?: ServedResource | null;
  restart?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  const copy = restart
    ? describePodRestart(name, namespace ?? null, detail, t)
    : describeDeletion(kind, name, namespace ?? null, detail, t);

  return (
    <DangerousConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={warned(copy.description, intercept)}
      details={
        open ? (
          <CascadePreview
            kind={kind}
            name={name}
            namespace={namespace}
            served={served}
          />
        ) : null
      }
      confirmationText={name}
      confirmLabel={t("action", restart ? "restart" : "delete")}
      isLoading={busy}
      onConfirm={onConfirm}
    />
  );
}

/**
 * A detail page's Delete, or a pod page's Restart: the same confirmation the
 * peek asks for. Nothing is deleted on the click itself.
 */
export function DeleteAction({
  kind,
  name,
  namespace,
  detail,
  intercept,
  mutation,
  served,
  disabled,
  restart = false,
}: {
  kind: string;
  name: string;
  namespace?: string | null;
  detail?: unknown;
  intercept: DeliveryIntercept | null;
  mutation: UseMutationResult<void, Error, void> | null;
  served?: ServedResource | null;
  disabled?: boolean;
  restart?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const guarded: Guarded | null = served
    ? {
        group: served.group,
        resource: served.plural,
        namespace: namespace ?? null,
      }
    : guardedOf(kind, namespace ?? null);
  const denied = useDenied(guarded).delete;
  if (!mutation) return null;
  const action = restart
    ? podRestartAction(detail as PodInfo | undefined, t)
    : { label: t("action", "delete"), icon: Trash2, danger: true };

  return (
    <>
      <ReasonedAction
        label={action.label}
        icon={action.icon}
        onClick={() => setOpen(true)}
        disabled={disabled}
        busy={mutation.isPending}
        danger={action.danger}
        reason={denied}
      />
      <DeletionDialog
        open={open}
        onOpenChange={setOpen}
        kind={kind}
        name={name}
        namespace={namespace}
        detail={detail}
        intercept={intercept}
        served={served}
        restart={restart}
        busy={mutation.isPending}
        onConfirm={() =>
          mutation.mutate(undefined, {
            onSettled: () => setOpen(false),
            onError: (error) => noteDenied("delete", guarded, error),
          })
        }
      />
    </>
  );
}
