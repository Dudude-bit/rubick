import { useState } from "react";
import { Scale } from "lucide-react";
import type { UseMutationResult } from "@tanstack/react-query";

import { ReasonedAction } from "@/components/object/detail-blocks";
import { useT } from "@/i18n/useT";
import type { ActionWarning } from "@/lib/governance";
import { ScaleDialog } from "./ScaleDialog";
import { useOpening } from "./use-opening";

/**
 * The Scale button and its dialog, holding the open state themselves. Held by
 * a whole detail page, pressing the button re-rendered the page's every tab
 * before the dialog could draw.
 */
export function ScaleControl({
  kind,
  name,
  namespace,
  current,
  ready,
  reason,
  warnings,
  reading = false,
  mutation,
}: {
  kind: string;
  name: string;
  namespace: string | null;
  current: number | undefined;
  ready: boolean;
  reason?: string | null;
  warnings: ActionWarning[];
  reading?: boolean;
  mutation: UseMutationResult<unknown, Error, number>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { opening, begin } = useOpening(open);
  return (
    <>
      <ReasonedAction
        label={t("action", "scale")}
        reason={reason}
        icon={Scale}
        busy={opening}
        onClick={() => ready && begin(() => setOpen(true))}
      />
      <ScaleDialog
        warnings={warnings}
        reading={reading}
        open={open}
        onOpenChange={(next) => {
          if (next) mutation.reset();
          setOpen(next);
        }}
        kind={kind}
        name={name}
        namespace={namespace}
        current={current}
        busy={mutation.isPending}
        error={mutation.isError ? mutation.error : null}
        onSubmit={(replicas) =>
          mutation.mutate(replicas, { onSuccess: () => setOpen(false) })
        }
      />
    </>
  );
}
