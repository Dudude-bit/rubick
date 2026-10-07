import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useResourceMutation } from "@/hooks";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { boundsProblem, type ActionWarning } from "@/lib/governance";
import { queryKeys } from "@/lib/query-keys";
import { guardedOf, noteDenied, useDenied } from "@/lib/access";
import { ReasonTip } from "@/components/object/detail-blocks";
import { cn } from "@/lib/utils";

/**
 * The way out the Scale dialog's autoscaler warning offers: the autoscaler's
 * own bounds, edited in place and patched behind a confirmation of its own.
 * `blocked` is the dialog's critical-cluster gate, which this obeys too.
 */
export function AutoscalerBounds({
  autoscaler,
  blocked,
}: {
  autoscaler: NonNullable<ActionWarning["autoscaler"]>;
  blocked: boolean;
}) {
  const t = useT();
  const id = useId();
  const [min, setMin] = useState(String(autoscaler.minReplicas));
  const [max, setMax] = useState(String(autoscaler.maxReplicas));
  const [confirming, setConfirming] = useState(false);
  const [tried, setTried] = useState(false);
  const bounds = { min: Number(min), max: Number(max) };
  const problem = boundsProblem(bounds.min, bounds.max);
  const unchanged =
    bounds.min === autoscaler.minReplicas &&
    bounds.max === autoscaler.maxReplicas;
  const guarded = guardedOf("HorizontalPodAutoscaler", autoscaler.namespace);
  const denied = useDenied(guarded).patch;

  const save = useResourceMutation(
    () =>
      commands.setAutoscalerBounds(
        autoscaler.name,
        autoscaler.namespace,
        bounds.min,
        bounds.max
      ),
    {
      toast: {
        successTitle: t("action", "hpaBoundsSaved"),
        successDescription: t("action", "hpaBoundsSavedDetail", {
          name: autoscaler.name,
          ...bounds,
        }),
        errorPrefix: t("action", "hpaBoundsFailed"),
      },
      invalidateQueryKeys: [
        ["connections"],
        queryKeys.details("HorizontalPodAutoscaler"),
      ],
      onSuccess: () => setConfirming(false),
      onError: (error) => noteDenied("patch", guarded, error),
    }
  );

  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 border-l-2 border-hair py-1 pl-2.5"
      data-testid="autoscaler-bounds"
    >
      <p className="text-xs text-fg-mut">{t("action", "hpaBoundsLead")}</p>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-fg">
            {t("action", "hpaBoundsConfirm", {
              name: autoscaler.name,
              ...bounds,
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirming(false)}
          >
            {t("action", "back")}
          </Button>
          <Button
            type="button"
            disabled={save.isPending || blocked}
            onClick={() => save.mutate()}
          >
            {t("action", "apply")}
          </Button>
        </div>
      ) : (
        <>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (problem || denied) return;
              if (unchanged) setTried(true);
              else setConfirming(true);
            }}
          >
            <div className="space-y-1">
              <Label htmlFor={`${id}-min`} className="font-mono text-[11px]">
                minReplicas
              </Label>
              <Input
                id={`${id}-min`}
                type="number"
                min={1}
                value={min}
                onChange={(event) => {
                  setMin(event.target.value);
                  setTried(false);
                }}
                className="h-7 w-24"
                aria-invalid={problem !== null}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-max`} className="font-mono text-[11px]">
                maxReplicas
              </Label>
              <Input
                id={`${id}-max`}
                type="number"
                min={1}
                value={max}
                onChange={(event) => {
                  setMax(event.target.value);
                  setTried(false);
                }}
                className="h-7 w-24"
                aria-invalid={problem === "hpaMinAboveMax"}
              />
            </div>
            <ReasonTip reason={denied}>
              <Button
                type="submit"
                variant="outline"
                disabled={!denied && problem !== null}
                aria-disabled={denied ? true : undefined}
                className={cn(denied && "cursor-default opacity-40")}
              >
                {t("action", "hpaBoundsChange")}
              </Button>
            </ReasonTip>
          </form>
          {problem ? (
            <p className="text-[11px] text-err" role="alert">
              {t("action", problem)}
            </p>
          ) : (
            tried &&
            unchanged && (
              <p className="text-[11px] text-fg-mut" role="status">
                {t("action", "hpaBoundsUnchanged", {
                  name: autoscaler.name,
                  ...bounds,
                })}
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}
