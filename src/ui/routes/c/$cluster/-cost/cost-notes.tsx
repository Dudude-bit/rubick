/**
 * What a cost picture cannot vouch for, each in its own sentence: an
 * unpriced node, storage nothing prices, a namespace nobody could read, a
 * label the series lack. None of them is a zero, and each one the page says
 * is said in the file Share writes too.
 */
import { Link } from "@tanstack/react-router";

import { useShareCaveat } from "@/components/share/screen-share";
import { Unknown } from "@/components/ui/unknown";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import type { CostPicture } from "@/lib/cost";
import { pageLink } from "@/lib/links";
import type { SupplierTrouble } from "@/hooks/useCost";
import { UnreadNamespaces } from "../-list/UnreadNamespaces";
import { pictureNotes, troubleWords } from "./cost-words";

export function CostNotes({
  picture,
  trouble,
  onRetry,
}: {
  picture: CostPicture;
  trouble: SupplierTrouble | null;
  onRetry?: () => void;
}) {
  const t = useT();
  const notes = pictureNotes(picture, t);
  const said = trouble
    ? `${troubleWords(trouble, t)} ${t("cost", "estimateMeanwhile")}`
    : null;
  useShareCaveat(said);
  useShareCaveat(notes.length > 0 ? notes.join(" ") : null);
  return (
    <div className="flex flex-col gap-1.5" data-testid="cost-notes">
      {said && (
        <p className="text-xs text-warn" data-testid="cost-trouble">
          {said}
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="text-xs text-warn">
          {note}
        </p>
      ))}
      <UnreadNamespaces
        unread={picture.unread}
        label={t("cost", "podsLabel")}
        onRetry={onRetry}
      />
    </div>
  );
}

/** Neither source: what each would give, and the way to each. */
export function NothingYet({ onPrices }: { onPrices: () => void }) {
  const t = useT();
  return (
    <p
      className="max-w-[72ch] px-1 py-4 text-xs text-fg-mut"
      data-testid="cost-nothing"
    >
      {parts(t("cost", "nothing"), {
        integrations: (
          <Link
            {...pageLink("integrations")}
            className="text-info hover:underline"
          >
            {t("cost", "integrationsLink")}
          </Link>
        ),
        prices: <PricesLink onPrices={onPrices} />,
      })}
    </p>
  );
}

function PricesLink({ onPrices }: { onPrices: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onPrices}
      className="text-info hover:underline"
    >
      {t("cost", "enterPrices")}
    </button>
  );
}

/** The supplier gave nothing and nobody entered prices. */
export function SupplierOnly({
  trouble,
  onPrices,
}: {
  trouble: SupplierTrouble;
  onPrices: () => void;
}) {
  const t = useT();
  const said = troubleWords(trouble, t);
  useShareCaveat(said);
  return (
    <div
      className="flex flex-col gap-1.5 px-1 py-4 text-xs"
      data-testid="cost-supplier"
    >
      <p className={trouble.kind === "noSeries" ? "text-fg-mut" : "text-warn"}>
        {said}
      </p>
      <p className="text-fg-mut">
        {parts(t("cost", "pricesOffer"), {
          prices: <PricesLink onPrices={onPrices} />,
        })}
      </p>
    </div>
  );
}

export function BasisFailed({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <Unknown
      question={t("cost", "basisQuestion")}
      error={error}
      onRetry={onRetry}
    />
  );
}
