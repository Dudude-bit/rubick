/**
 * The Cost page's sentences, from a picture: what the page, its notes, the
 * detail pages' lines and the file Share writes all say alike.
 */
import type { T } from "@/i18n/useT";
import {
  costOf,
  currencyOf,
  formatMoney,
  formatShare,
  monthOf,
  type Amount,
  type CostPicture,
  type CostTarget,
} from "@/lib/cost";
import { EFFICIENCY_WINDOW, type Efficiency } from "@/lib/efficiency";
import { formatBytes } from "@/lib/k8s-quantity";
import type { SupplierTrouble } from "@/hooks/useCost";

const names = (list: readonly string[]) => list.join(", ");

/** An amount, said as "at least" where something in it carries no price. */
export function amountWords(amount: Amount, currency: string, t: T): string {
  const money = formatMoney(amount.perHour, currency);
  return amount.atLeast ? t("cost", "atLeast", { amount: money }) : money;
}

/** Where the numbers come from, in one line under the title. */
export function sourceWords(
  picture: CostPicture,
  context: string,
  t: T
): string {
  if (picture.source.kind === "opencost")
    return t("cost", "fromOpenCost", { endpoint: picture.source.endpoint });
  const { prices } = picture.source;
  const each = [
    t("cost", "priceCpu", { price: formatMoney(prices.cpu, prices.currency) }),
    t("cost", "priceMemory", {
      price: formatMoney(prices.memory, prices.currency),
    }),
    prices.storage === null
      ? t("cost", "priceNoStorage")
      : t("cost", "priceStorage", {
          price: formatMoney(prices.storage, prices.currency),
        }),
    ...(prices.gpu === null
      ? []
      : [
          t("cost", "priceGpu", {
            price: formatMoney(prices.gpu, prices.currency),
          }),
        ]),
  ];
  return t("cost", "fromPrices", { context, prices: each.join(" · ") });
}

/** The supplier's own trouble, in the words it gave. */
export function troubleWords(trouble: SupplierTrouble, t: T): string {
  switch (trouble.kind) {
    case "noSeries":
      return t("cost", "noSeries", { endpoint: trouble.endpoint });
    case "unreachable":
      return t("cost", "unreachable", {
        endpoint: trouble.endpoint,
        said: trouble.said,
      });
    case "failed":
      return t("cost", "failed", {
        endpoint: trouble.endpoint,
        said: trouble.said,
      });
  }
}

/** Every reason the picture is a floor or a part, as sentences. */
export function pictureNotes(picture: CostPicture, t: T): string[] {
  const { unpriced } = picture;
  const opencost = picture.source.kind === "opencost";
  const notes: string[] = [];
  if (unpriced.nodes.length > 0)
    notes.push(
      t("cost", opencost ? "nodesUnpricedOpenCost" : "nodesUnpriced", {
        n: unpriced.nodes.length,
        names: names(unpriced.nodes),
      })
    );
  if (unpriced.gpuNodes.length > 0)
    notes.push(t("cost", "gpusUnpriced", { names: names(unpriced.gpuNodes) }));
  if (unpriced.storage)
    notes.push(
      t("cost", opencost ? "storageUnpricedOpenCost" : "storageUnpriced", {
        volumes: t("count", "volumes", { n: unpriced.storage.volumes }),
        size: formatBytes(unpriced.storage.bytes, { trim: true }),
      })
    );
  if (unpriced.volumes.length > 0)
    notes.push(
      t("cost", "volumesUnpriced", {
        n: unpriced.volumes.length,
        names: names(unpriced.volumes),
      })
    );
  if (unpriced.unsized.length > 0)
    notes.push(
      t("cost", "volumesUnsized", {
        n: unpriced.unsized.length,
        names: names(unpriced.unsized),
      })
    );
  if (picture.nodesUnread)
    notes.push(
      t("cost", opencost ? "nodesNotChecked" : "nodesUnread", {
        said: picture.nodesUnread.message,
      })
    );
  if (picture.missingLabels.length > 0)
    notes.push(
      t("cost", "missingLabels", { labels: picture.missingLabels.join(", ") })
    );
  if (picture.workloadsFailed)
    notes.push(t("cost", "workloadsFailed", { said: picture.workloadsFailed }));
  const currency = currencyOf(picture);
  for (const unplaced of picture.unplaced)
    notes.push(
      t("cost", "unplaced", {
        n: unplaced.pods,
        namespace: unplaced.namespace,
        amount: formatMoney(unplaced.perHour, currency),
      })
    );
  if (picture.waiting > 0)
    notes.push(t("cost", "waiting", { n: picture.waiting }));
  return notes;
}

/** The line's words for a picture: its cost, or why it has none. */
export function costLineWords(
  picture: CostPicture,
  target: CostTarget,
  t: T
): string {
  const of = costOf(picture, target);
  if (!of) {
    if ("kind" in target && picture.rest)
      return t("cost", "lineCut", { kept: picture.workloads.length });
    return t("cost", "lineNothingOnANode");
  }
  if (of.perHour === null) return t("cost", "lineNotPriced");
  const currency = currencyOf(picture);
  // Some of what it holds carries no price: its own amount is a floor.
  const amount = (perHour: number) =>
    amountWords({ perHour, atLeast: of.partial }, currency, t);
  const parts = [
    t("cost", "linePerHour", { amount: amount(of.perHour) }),
    t("cost", "linePerMonth", { amount: amount(monthOf(of.perHour)) }),
  ];
  if (of.share !== null)
    parts.push(
      t("cost", of.atLeast ? "lineShareAtMost" : "lineShare", {
        share: formatShare(of.share),
      })
    );
  parts.push(
    t(
      "cost",
      picture.source.kind === "opencost" ? "lineFromOpenCost" : "lineFromPrices"
    )
  );
  return parts.join(" · ");
}

const EFFICIENCY_WORDS: Record<
  Exclude<Efficiency["state"], "measured">,
  (e: Efficiency, t: T) => string
> = {
  noSupplier: (_, t) => t("cost", "effNoSupplier"),
  reading: (_, t) => t("cost", "effReading"),
  failed: (e, t) =>
    t("cost", "effFailed", { said: e.state === "failed" ? e.said : "" }),
  noSamples: (_, t) => t("cost", "effNoSamples", { window: EFFICIENCY_WINDOW }),
  unrequested: (_, t) => t("cost", "effUnrequested"),
};

/** One resource's efficiency, worded; never a 0% or a 100% it did not measure. */
export function efficiencyWords(e: Efficiency, t: T): string {
  if (e.state !== "measured") return EFFICIENCY_WORDS[e.state](e, t);
  return t("cost", "effMeasured", {
    avg: e.ratio === null ? t("cost", "notMeasured") : formatShare(e.ratio),
    peak:
      e.peakRatio === null
        ? t("cost", "notMeasured")
        : formatShare(e.peakRatio),
  });
}
