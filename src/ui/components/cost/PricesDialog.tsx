/**
 * What a cluster's resources cost, as the reader says: one dialog, opened
 * from the Cost page and from the cluster's row in Settings.
 */
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n/useT";
import { useCostPrices, useCostPricesStore } from "@/stores/costPricesStore";
import {
  FIELDS,
  LABEL,
  REQUIRED,
  draftOf,
  pricesFromDraft,
  type Draft,
  type Field,
} from "./prices-draft";

export function PricesDialog({
  context,
  open,
  onOpenChange,
  supplierAnswers = false,
}: {
  context: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A supplier prices this cluster now, so these are not what the page shows. */
  supplierAnswers?: boolean;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("cost", "pricesTitle", { context })}</DialogTitle>
          <DialogDescription>{t("cost", "pricesHint")}</DialogDescription>
        </DialogHeader>
        {supplierAnswers && (
          <p className="text-xs text-warn" data-testid="prices-not-used">
            {t("cost", "pricesNotUsed")}
          </p>
        )}
        <PricesForm context={context} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Mounted with the dialog's content, so each opening starts from what is saved. */
function PricesForm({
  context,
  onDone,
}: {
  context: string;
  onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const saved = useCostPrices(context);
  const setPrices = useCostPricesStore((s) => s.setPrices);
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [touched, setTouched] = useState(false);

  const answer = pricesFromDraft(draft);
  const save = () => {
    setTouched(true);
    if (!answer.prices) return;
    setPrices(context, answer.prices);
    onDone();
  };

  return (
    <>
      <form
        className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-x-3 gap-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {FIELDS.map((field) => {
          const wrong =
            touched && (answer.wrong as readonly Field[]).includes(field);
          return (
            <div key={field} className="contents">
              <Label htmlFor={`${id}-${field}`} className="text-xs">
                {t("cost", LABEL[field])}
                {!REQUIRED[field] && (
                  <span className="ml-1 text-fg-fnt">
                    {t("cost", "optional")}
                  </span>
                )}
              </Label>
              <Input
                id={`${id}-${field}`}
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={wrong}
                className="h-7 font-mono text-xs tabular-nums"
                value={draft[field]}
                onChange={(event) =>
                  setDraft((d) => ({ ...d, [field]: event.target.value }))
                }
              />
            </div>
          );
        })}
        <Label htmlFor={`${id}-currency`} className="text-xs">
          {t("cost", "fieldCurrency")}
          <span className="ml-1 text-fg-fnt">{t("cost", "optional")}</span>
        </Label>
        <Input
          id={`${id}-currency`}
          autoComplete="off"
          maxLength={8}
          className="h-7 text-xs"
          value={draft.currency}
          onChange={(event) =>
            setDraft((d) => ({ ...d, currency: event.target.value }))
          }
        />
        {touched && answer.wrong.length > 0 && (
          <p className="col-span-2 text-xs text-err" role="alert">
            {t("cost", "pricesWrong")}
          </p>
        )}
        <button type="submit" hidden />
      </form>
      <DialogFooter>
        {saved && (
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              setPrices(context, null);
              onDone();
            }}
          >
            {t("cost", "pricesForget")}
          </Button>
        )}
        <Button variant="outline" onClick={onDone}>
          {t("action", "cancel")}
        </Button>
        <Button onClick={save}>{t("action", "save")}</Button>
      </DialogFooter>
    </>
  );
}
