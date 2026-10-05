import type { RolloutPlan } from "@/generated/types";
import type { T } from "@/i18n/useT";

export interface RestartWords {
  text: string;
  /** `warn` where the restart is not the gentle rolling one a reader expects. */
  tone: "info" | "warn";
}

/**
 * What a rolling restart will do, in the numbers the controller resolved:
 * how many pods, how many may be missing or extra at a time, in what order.
 * `undefined` is a workload not read yet, which gets the general sentence
 * rather than a guess.
 */
export function restartWords(
  plan: RolloutPlan | undefined,
  name: string,
  t: T
): RestartWords {
  if (!plan) return { text: t("action", "restartPlanUnknown"), tone: "info" };
  switch (plan.strategy) {
    case "rolling":
      if (plan.replicas <= 0)
        return { text: t("action", "restartNothingRuns"), tone: "info" };
      return {
        text: t("action", "restartPlanRolling", {
          replaces: t("count", "restartPods", { n: plan.replicas }),
          unavailable:
            plan.unavailable === 0
              ? t("action", "restartNoneUnavailable")
              : t("count", "restartUnavailable", { n: plan.unavailable }),
          extra:
            plan.surge === 0
              ? t("action", "restartNoExtra")
              : t("count", "restartExtra", { n: plan.surge }),
        }),
        tone: "info",
      };
    case "recreate":
      if (plan.replicas <= 0)
        return { text: t("action", "restartNothingRuns"), tone: "info" };
      return {
        text: t("count", "restartPlanRecreate", { n: plan.replicas }),
        tone: "warn",
      };
    case "ordered": {
      const end = plan.start + plan.replicas;
      const from = Math.max(plan.partition, plan.start);
      if (plan.replicas <= 0)
        return { text: t("action", "restartNothingRuns"), tone: "info" };
      if (from >= end)
        return {
          text: t("action", "restartPartitionHoldsAll", {
            partition: plan.partition,
          }),
          tone: "warn",
        };
      const replaces = t("count", "restartPods", { n: end - from });
      const last = `${name}-${end - 1}`;
      const first = `${name}-${from}`;
      const moving =
        plan.unavailable > 1
          ? t("action", "restartPlanOrderedBatch", {
              replaces,
              last,
              first,
              n: plan.unavailable,
            })
          : t("action", "restartPlanOrdered", { replaces, last, first });
      return {
        text:
          from > plan.start
            ? `${moving} ${t("action", "restartPartitionHolds", { partition: plan.partition })}`
            : moving,
        tone: from > plan.start ? "warn" : "info",
      };
    }
    case "onDelete":
      return { text: t("action", "restartPlanOnDelete"), tone: "warn" };
    case "nodes":
      if (plan.nodes <= 0)
        return { text: t("action", "restartNoNodes"), tone: "info" };
      return {
        text:
          plan.surge > 0
            ? t("action", "restartPlanNodesSurge", {
                nodes: t("count", "restartOfNodes", { n: plan.nodes }),
                n: plan.surge,
              })
            : t("action", "restartPlanNodes", {
                nodes: t("count", "restartOfNodes", { n: plan.nodes }),
                n: plan.unavailable,
              }),
        tone: "info",
      };
  }
}
