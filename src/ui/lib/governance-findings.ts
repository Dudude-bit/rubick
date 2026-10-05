import type { T } from "@/i18n/useT";
import type { ResourceConnections } from "@/generated/types";
import { unreadWhy } from "./connections";
import {
  autoscalerFinding,
  autoscalerScaleWarnings,
  autoscalers,
  budgetFinding,
  budgets,
  type Finding,
} from "./governance";

/** The two kinds whose findings speak for a workload. */
const GOVERNING = ["HorizontalPodAutoscaler", "PodDisruptionBudget"];

/**
 * Every sentence the autoscalers and budgets on a workload earn, soonest
 * stop first: what could not be read, several autoscalers fighting, then each
 * autoscaler's and each budget's own finding. The page's count block and the
 * peek both read this, so the two cannot disagree about an HPA that cannot
 * read its metrics.
 */
export function governanceFindings(
  conns: ResourceConnections | null | undefined,
  t: T
): Finding[] {
  if (!conns) return [];
  const findings: Finding[] = [];
  // A kind the app asked for and did not get is not a kind with nothing in it.
  for (const entry of conns.notLookedAt.filter((entry) =>
    GOVERNING.includes(entry.kind)
  )) {
    findings.push({
      tone: "neutral",
      title: t("readings", "govNotRead", { kind: entry.kind }),
      detail: unreadWhy(entry.why, t),
    });
  }
  const scaling = autoscalers(conns);
  if (scaling.length > 1) {
    const several = autoscalerScaleWarnings(conns, t).find(
      (warning) => warning.key === "hpa:several"
    );
    if (several) {
      findings.push({
        tone: "warn",
        title: t("readings", "govSeveralAutoscalers", { n: scaling.length }),
        detail: several.description,
      });
    }
  }
  for (const auto of scaling) {
    const finding = autoscalerFinding(auto, t);
    if (finding) findings.push(finding);
  }
  for (const budget of budgets(conns)) {
    const finding = budgetFinding(budget, t);
    if (finding && finding.tone !== "neutral") findings.push(finding);
  }
  return findings;
}
