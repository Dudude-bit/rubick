import type { UseMutationResult } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import { describeDeletion } from "../-peek/peek-actions";
import { CascadePreview } from "./CascadePreview";
import type { ServedResource } from "./served";
import { warned } from "./useObjectActions";
import { DetailAction } from "@/components/object/detail-blocks";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import type { DeliveryIntercept } from "@/lib/delivery";
import { useT } from "@/i18n/useT";

/**
 * A detail page's Delete: the same confirmation the peek asks for, the
 * object's name typed, what a delivery controller will do about it, and
 * what goes with it. Nothing is deleted on the click itself.
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
}: {
  kind: string;
  name: string;
  namespace?: string | null;
  detail?: unknown;
  intercept: DeliveryIntercept | null;
  mutation: UseMutationResult<void, Error, void> | null;
  served?: ServedResource | null;
  disabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!mutation) return null;
  const deletion = describeDeletion(kind, name, namespace ?? null, detail, t);

  return (
    <>
      <DetailAction
        label={t("action", "delete")}
        icon={Trash2}
        onClick={() => setOpen(true)}
        disabled={disabled}
        busy={mutation.isPending}
        danger
      />
      <DangerousConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={deletion.title}
        description={warned(deletion.description, intercept)}
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
        confirmLabel={t("action", "delete")}
        isLoading={mutation.isPending}
        onConfirm={() =>
          mutation.mutate(undefined, { onSettled: () => setOpen(false) })
        }
      />
    </>
  );
}
