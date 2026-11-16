import type { T } from "@/i18n/useT";
import { notRecheckedWords, type AttentionItem } from "@/lib/attention";
import { autoscalerFinding, type Finding } from "@/lib/governance";
import { detailWords } from "../-overview/health-share";

/**
 * A row's item worded as its object's page words the finding: an autoscaler's
 * through the page's own composer, so the peek says "api cannot reach what it
 * scales" whether the row or its own read named it. One kept over a read that
 * no longer answers keeps its severity and says it is last known, and since
 * when, as the chip does.
 */
export function itemFinding(item: AttentionItem, t: T): Finding {
  const said = (item.autoscaler && autoscalerFinding(item.autoscaler, t)) ?? {
    tone: item.tone,
    title: item.reason,
    detail: detailWords(item.detail, t) ?? "",
  };
  return item.stale
    ? {
        ...said,
        title: `${said.title} · ${notRecheckedWords(t, item.lastKnown?.at)}`,
      }
    : said;
}
