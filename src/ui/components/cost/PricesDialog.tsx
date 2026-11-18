/**
 * What a cluster's resources cost, as the reader says: one dialog, opened
 * from the Cost page and from the cluster's row in Settings.
 */
import { useEffect, useId, useState } from "react";

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
import { persistedByName } from "@/lib/kept-by-name";
import { entryOf } from "@/lib/named";
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
        <PricesForm
          key={context}
          context={context}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mounted with the dialog's content and again for each context, so each
 * opening, and each cluster, starts from what is saved.
 */
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
  const [drawnFrom] = useState(saved);
  const [touched, setTouched] = useState(false);
  // The name turned into another cluster while the form was open: what it
  // holds are the old cluster's prices, and Save must not give them to it.
  // A turn told again as it subscribes came before it was drawn only where
  // what it was drawn from is still what is saved; one between the drawing
  // and the subscription took that away.
  useEffect(() => {
    let open = false;
    const off = persistedByName((turned) => {
      if (turned !== context) return;
      const kept =
        (entryOf(useCostPricesStore.getState().prices, context) ?? null) ===
        drawnFrom;
      if (!open && kept) return;
      setDraft(draftOf(null));
      setTouched(false);
    });
    open = true;
    return off;
  }, [context, drawnFrom]);

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
