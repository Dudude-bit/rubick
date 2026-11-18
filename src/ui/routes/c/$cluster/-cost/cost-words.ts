/**
 * The Cost page's sentences, from a picture: what the page, its notes, the
 * detail pages' lines and the file Share writes all say alike.
 */
import type { T } from "@/i18n/useT";
import {
  costOf,
  totalUnknown,
  type RowShare,
  type CostPart,
  type Parts,
  currencyOf,
  formatMoney,
  formatShare,
  monthOf,
  type Amount,
  type CostPicture,
  type CostTarget,
} from "@/lib/cost";
import {
  EFFICIENCY_WINDOW,
  windowWords,
  type Efficiency,
} from "@/lib/efficiency";
import { formatBytes } from "@/lib/k8s-quantity";
import { formatQuantity } from "@/lib/metric-format";
import { formatAge } from "@/lib/utils";
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
    case "noNodePrices":
      return trouble.lastFailed === null
        ? t("cost", "noNodePrices", { endpoint: trouble.endpoint })
        : t("cost", "noNodePricesLastFailed", {
            endpoint: trouble.endpoint,
            said: trouble.lastFailed,
          });
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
    case "lastFailed":
      return t("cost", "lastFailed", {
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
      t("cost", "nodesUnread", {
        said: picture.nodesUnread.message,
      })
    );
  if (picture.foreignNodes.length > 0 && picture.source.kind === "opencost")
    notes.push(
      t("cost", "foreignNodes", {
        n: picture.foreignNodes.length,
        names: names(picture.foreignNodes),
        endpoint: picture.source.endpoint,
      })
    );
  if (picture.jobsUnread)
    notes.push(t("cost", "jobsUnread", { said: picture.jobsUnread.message }));
  // OpenCost says what each node holds itself; only an estimate counts it.
  if (picture.heldUnread && !opencost)
    notes.push(t("cost", "heldUnread", { said: picture.heldUnread.message }));
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
/**
 * One object's cost line, and whether it says a read did not answer: that
 * is amber, where a part with no price is not.
 */
export function costLineWords(
  picture: CostPicture,
  target: CostTarget,
  t: T
): { words: string; unread: boolean } {
  const unread = (words: string) => ({ words, unread: true });
  const of = costOf(picture, target);
  // Its namespace's pods could not be read: no row, or one with no price,
  // is the refusal, not an absence.
  const refused = picture.unread.some((u) => u.namespace === target.namespace);
  if (refused && (!of || of.perHour === null))
    return unread(t("cost", "lineUnread"));
  // What each workload costs was not read: its row has no price for that
  // reason, not for want of a price.
  if ("kind" in target && picture.workloadsFailed && of?.perHour === null)
    return unread(t("cost", "lineFailed", { said: picture.workloadsFailed }));
  // A CronJob's runs went under each Job while the Jobs were refused.
  if (
    !of &&
    "kind" in target &&
    target.kind === "CronJob" &&
    picture.jobsUnread
  )
    return unread(
      t("cost", "lineJobsUnread", { said: picture.jobsUnread.message })
    );
  // Nothing of it priced, and how much it holds was not read.
  if (of?.unknown) return unread(t("cost", "lineUnread"));
  return { words: readLineWords(picture, target, of, t), unread: false };
}

function readLineWords(
  picture: CostPicture,
  target: CostTarget,
  of: ReturnType<typeof costOf>,
  t: T
): string {
  if (!of) {
    if (!("kind" in target)) return t("cost", "lineNothingOnANode");
    if (picture.rest)
      return t("cost", "lineCut", { kept: picture.workloads.length });
    // The line is drawn beside running pods: a workload with no row was not
    // in what the cost was read from, which says nothing about its pods.
    return t("cost", "lineNotRead");
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
  const ofCluster = clusterShareWords(of.share, t);
  if (ofCluster) parts.push(ofCluster);
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
  noSamples: (e, t) => {
    const age = youngFor(e, t);
    return age === null
      ? t("cost", "effNoSamples", { window: windowWords(EFFICIENCY_WINDOW, t) })
      : t("cost", "effNoSamplesYet", { age });
  },
  unrequested: (_, t) => t("cost", "effUnrequested"),
};

/** How long the readings cover where that is less than the window: its youngest pod's age. */
export function youngFor(e: Efficiency, t: T): string | null {
  if (
    e.state !== "measured" &&
    e.state !== "unrequested" &&
    e.state !== "noSamples"
  )
    return null;
  return e.whole || e.since === null ? null : formatAge(e.since, t);
}

/** A peak as it was read: summed over several pods it is a bound, and says so. */
const peakSaid = (e: Efficiency, value: string, t: T) =>
  (e.state === "measured" || e.state === "unrequested") && e.peakAtMost
    ? t("cost", "atMost", { value })
    : value;

/** A line of figures read from some of its pods, saying which. */
const fromPods = (e: Efficiency, line: string, t: T) =>
  (e.state === "measured" || e.state === "unrequested") && e.podsRead
    ? t("cost", "fromPods", {
        line,
        read: e.podsRead.read,
        n: e.podsRead.of,
      })
    : line;

/** One resource's efficiency, worded; never a 0% or a 100% it did not measure. */
export function efficiencyWords(e: Efficiency, t: T): string {
  if (e.state !== "measured") return EFFICIENCY_WORDS[e.state](e, t);
  const values = {
    avg: e.ratio === null ? t("cost", "notMeasured") : formatShare(e.ratio),
    peak:
      e.peakRatio === null
        ? t("cost", "notMeasured")
        : peakSaid(e, formatShare(e.peakRatio), t),
  };
  const age = youngFor(e, t);
  return fromPods(
    e,
    age === null
      ? t("cost", "effMeasured", values)
      : t("cost", "effMeasuredFor", { ...values, age }),
    t
  );
}

/** What one resource used, in its own units, over the span the readings cover. */
export function usedWords(e: Efficiency, kind: "cpu" | "memory", t: T): string {
  if (e.state === "noSamples" && youngFor(e, t) !== null)
    return t("cost", "noSamplesYet");
  if (e.state !== "measured" && e.state !== "unrequested")
    return t("cost", "notMeasured");
  const say = (v: number | null) =>
    v === null ? t("cost", "notMeasured") : formatQuantity(v, kind);
  const values = {
    avg: say(e.avg),
    peak: e.peak === null ? say(null) : peakSaid(e, say(e.peak), t),
  };
  const age = youngFor(e, t);
  return fromPods(
    e,
    age === null
      ? t("cost", "usedAvgPeak", values)
      : t("cost", "usedAvgPeakFor", { ...values, age }),
    t
  );
}

/**
 * The same, as the cell draws it: the average on one line and the peak on
 * the next, so the column is as wide as the longer of the two.
 */
export function usedLines(
  e: Efficiency,
  kind: "cpu" | "memory",
  t: T
): [string] | [string, string] {
  if (e.state === "noSamples" && youngFor(e, t) !== null)
    return [t("cost", "noSamplesYet")];
  if (e.state !== "measured" && e.state !== "unrequested")
    return [t("cost", "notMeasured")];
  const say = (v: number | null) =>
    v === null ? t("cost", "notMeasured") : formatQuantity(v, kind);
  const age = youngFor(e, t);
  const peak = e.peak === null ? say(null) : peakSaid(e, say(e.peak), t);
  return [
    t("cost", "usedAvg", { avg: say(e.avg) }),
    fromPods(
      e,
      age === null
        ? t("cost", "usedPeak", { peak })
        : t("cost", "usedPeakFor", { peak, age }),
      t
    ),
  ];
}

/**
 * What a money cell says: an amount, an amount that is a floor, no price
 * for what is there, or nothing there to price.
 */
export type Said =
  | number
  | { atLeast: number }
  | "notPriced"
  | "notKnown"
  | "none";

export function money(
  value: Said | null | undefined,
  currency: string,
  t: T
): string {
  if (value === null || value === undefined || value === "notPriced")
    return t("cost", "notPriced");
  if (value === "none") return t("empty", "noneLower");
  if (value === "notKnown") return t("cost", "notKnown");
  if (typeof value === "number") return formatMoney(value, currency);
  return t("cost", "atLeast", { amount: formatMoney(value.atLeast, currency) });
}

/** A row's total: a floor where some of what it holds carries no price. */
export const totalOf = (
  row: Parameters<typeof totalUnknown>[0] & { atLeast: boolean },
  scale = 1
): Said =>
  row.perHour === null
    ? totalUnknown(row)
      ? "notKnown"
      : "notPriced"
    : row.atLeast
      ? { atLeast: row.perHour * scale }
      : row.perHour * scale;

/** One part: its price, no price for what is there, or nothing there. */
export const partOf = (
  row: {
    parts: Parts;
    unpriced: readonly CostPart[];
    unknown: readonly CostPart[];
  },
  part: CostPart
): Said =>
  row.parts[part] ??
  (row.unknown.includes(part)
    ? "notKnown"
    : row.unpriced.includes(part)
      ? "notPriced"
      : "none");

export const sortable = (said: Said): number =>
  typeof said === "number"
    ? said
    : typeof said === "object"
      ? said.atLeast
      : said === "none"
        ? 0
        : -1;

/** A share of the cluster, as an object's line and the scope's tile say it. */
export function clusterShareWords(share: RowShare, t: T): string | null {
  if (share === null) return null;
  if (share === "noTotal") return t("cost", "lineShareNoTotal");
  return t("cost", share.atMost ? "lineShareAtMost" : "lineShare", {
    share: formatShare(share.of),
  });
}

/**
 * A row's share of the whole: at most where the whole is a floor, not known
 * where the whole is, and not priced only where the row is not.
 */
export function share(
  row: Parameters<typeof totalUnknown>[0] & { share: RowShare },
  t: T
): string {
  if (row.share === "noTotal") return t("cost", "shareNoTotal");
  if (row.share)
    return row.share.atMost
      ? t("cost", "atMost", { value: formatShare(row.share.of) })
      : formatShare(row.share.of);
  return t("cost", totalUnknown(row) ? "notKnown" : "notPriced");
}

/** A share as a number to sort by: one with none sorts last. */
export const shareSortable = (value: RowShare): number =>
  value && value !== "noTotal" ? value.of : -1;
