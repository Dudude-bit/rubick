/**
 * What is acting on this workload without it having asked, as rows inside the
 * block whose subject that action is.
 *
 * An HPA is a property of the thing it scales and a PodDisruptionBudget is a
 * property of the pods it protects; neither owns a topology and neither has
 * anything under it, so neither gets a nav entry. What they also do not get,
 * any more, is a block of their own: "who sets the replica count" and "what a
 * drain must respect" are two sentences about *the count*, and as two separate
 * sections in a page-level grid they landed in opposite columns while the
 * number they qualify was stated a third time between them.
 *
 * So they are three rows — `Set by`, `Now`, `A drain waits` — and a row with no
 * subject does not render. A workload with neither an autoscaler nor a budget
 * shows its bar and nothing else, which is most workloads.
 *
 * Nothing here says "there is no autoscaler". That claim belongs to the
 * Connections tab, which makes it once and with the caveat about a read that
 * failed attached to it.
 */

import { ResourceRef } from "./ResourceRef";
import {
  autoscalerFinding,
  autoscalerRange,
  autoscalerScaleWarnings,
  autoscalers,
  budgetFinding,
  budgetRoom,
  budgetRule,
  budgets,
  lastScaled,
  metricReadings,
  type AutoscalerFacts,
  type Finding,
} from "@/lib/governance";
import type { KeyValue } from "./key-values";
import type { ResourceConnections } from "@/generated/types";

/**
 * What the autoscaler is reading right now, and when it last acted.
 *
 * A reading the autoscaler never took is drawn as an absence and not as a zero
 * or a dash: an HPA that cannot reach its metric source publishes no
 * `currentMetrics` at all, and every other number on the object stays exactly
 * as it looks on a working one.
 *
 * The replica numbers it also publishes are deliberately not here. They are
 * the same count the bar beside this is already drawing, and stating it twice
 * in one block is the thing this composition exists to stop; where they mean
 * something other than the count — an autoscaler that computed nothing — the
 * finding under the rows says so in words.
 */
function nowValue(facts: AutoscalerFacts) {
  const readings = metricReadings(facts);
  const scaled = lastScaled(facts);
  if (readings.length === 0 && scaled === null) return null;

  return (
    <span className="flex flex-col gap-0.5">
      {readings.map((metric) => (
        <span
          key={metric.key}
          className="flex flex-wrap items-baseline gap-x-2"
        >
          <span className="font-mono">{metric.label}</span>
          {metric.current === null ? (
            <span className="text-[11px] text-warn">no reading</span>
          ) : (
            <span className="font-mono">{metric.current}</span>
          )}
          <span className="text-[11px] text-fg-fnt">
            against {metric.target}
            {metric.from ? ` · ${metric.from}` : ""}
          </span>
        </span>
      ))}
      {scaled && <span className="text-[11px] text-fg-fnt">{scaled}</span>}
    </span>
  );
}

export interface Governance {
  /** `Set by`, `Now`, `A drain waits` — only the ones with a subject. */
  rows: KeyValue[];
  /** The states worth a sentence, under the rows. */
  findings: Finding[];
  /** Whether an autoscaler owns the count, for the block's caption. */
  sets: boolean;
  /** Whether a budget guards the pods, likewise. */
  guards: boolean;
}

/**
 * The rows and the prose, from the `governs` edges the connections call
 * already returned.
 *
 * Prose is what an unusual state earns. A budget that allows no disruption
 * because it is exactly met is the budget doing its job — it is a clause on
 * its own row and nothing more. A budget below its own floor blocks a drain
 * until the workload recovers, and keeps its coloured sentence.
 */
export function governanceRows(
  conns: ResourceConnections | null | undefined
): Governance {
  const rows: KeyValue[] = [];
  const findings: Finding[] = [];
  if (!conns) return { rows, findings, sets: false, guards: false };

  const scaling = autoscalers(conns);
  const protecting = budgets(conns);

  // Two autoscalers on one workload used to be said in the block's caption,
  // and the caption is now the composition's fixed subject line. It is not a
  // qualifier anyway: neither range on the page is the range while it is true.
  if (scaling.length > 1) {
    const several = autoscalerScaleWarnings(conns).find(
      (warning) => warning.key === "hpa:several"
    );
    if (several) {
      findings.push({
        tone: "warn",
        title: `${scaling.length} autoscalers claim this — each undoes the other`,
        detail: several.description,
      });
    }
  }

  for (const auto of scaling) {
    rows.push({
      label: "Set by",
      value: (
        <>
          <ResourceRef
            kind={auto.object.kind}
            name={auto.object.name}
            namespace={auto.object.namespace}
            showKind={false}
          />
          <span className="text-fg-fnt"> · {autoscalerRange(auto.facts)}</span>
        </>
      ),
    });

    const now = nowValue(auto.facts);
    if (now) rows.push({ label: "Now", value: now });

    const finding = autoscalerFinding(auto);
    if (finding) findings.push(finding);
  }

  for (const budget of protecting) {
    rows.push({
      label: "A drain waits",
      value: (
        <>
          <ResourceRef
            kind={budget.object.kind}
            name={budget.object.name}
            namespace={budget.object.namespace}
            showKind={false}
          />
          <span className="text-fg-fnt">
            {" "}
            keeps {budgetRule(budget.facts)} — {budgetRoom(budget.facts)}
          </span>
        </>
      ),
    });

    const finding = budgetFinding(budget);
    if (finding && finding.tone !== "neutral") findings.push(finding);
  }

  return {
    rows,
    findings,
    sets: scaling.length > 0,
    guards: protecting.length > 0,
  };
}
