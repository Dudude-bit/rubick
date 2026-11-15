import type { T } from "@/i18n/useT";
import type { AttentionItem } from "@/lib/attention";
import { autoscalerFinding, type Finding } from "@/lib/governance";
import { detailWords } from "../-overview/health-share";

/**
 * A row's item worded as its object's page words the finding: an autoscaler's
 * through the page's own composer, so the peek says "api cannot reach what it
 * scales" whether the row or its own read named it. One kept over a read that
 * no longer answers is last known, as the chip says.
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
        tone: "warn",
        title: `${said.title} · ${t("cluster", "problemNotRechecked")}`,
      }
    : said;
}
