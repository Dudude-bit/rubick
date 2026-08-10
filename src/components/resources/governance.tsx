/**
 * What is acting on this workload without it having asked, on the page of the
 * thing being acted on.
 *
 * Two blocks and no page of their own, deliberately. An HPA is a property of
 * the thing it scales and a PodDisruptionBudget is a property of the pods it
 * protects; neither owns a topology, neither has anything under it, and a nav
 * entry for either would be a list of objects nobody navigates *to*. Both are
 * read on the workload, where the question is asked.
 *
 * Nothing is drawn for a workload that has neither, and that includes the
 * heading — an empty "Autoscaling" block would say "there is no autoscaler",
 * which is a claim the Connections tab makes properly, once, with the caveat
 * about a read that failed attached to it.
 */

import { Section, SectionHeader } from "@/components/ui/section";
import { KeyValueRow } from "./detail-kv";
import { ResourceRef } from "./ResourceRef";
import type { ConnectionsQuery } from "@/hooks/useConnections";
import {
  autoscalerFinding,
  autoscalerRange,
  autoscalerReplicas,
  autoscalers,
  budgetFinding,
  budgetRoom,
  budgetRule,
  budgets,
  metricReadings,
  type Finding,
} from "@/lib/governance";
import { cn } from "@/lib/utils";

const FINDING_TONE: Record<Finding["tone"], string> = {
  err: "text-err",
  warn: "text-warn",
  // The honest one. `disruptionsAllowed: 0` on a budget that is exactly met
  // is a fact the reader wants and is not a fault, so it reads in the same
  // foreground every other stated fact on the page reads in.
  neutral: "text-fg-mut",
};

function FindingLine({ finding }: { finding: Finding }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1.5">
      <p className={cn("text-xs font-medium", FINDING_TONE[finding.tone])}>
        {finding.title}
      </p>
      <p className="text-[11px] text-fg-fnt">{finding.detail}</p>
    </div>
  );
}

/**
 * The metric row, whose empty value is the finding.
 *
 * A reading the autoscaler never took is drawn as an absence and not as a
 * zero or a dash: an HPA that cannot reach its metric source publishes no
 * `currentMetrics` at all, and every other number on the object stays exactly
 * as it looks on a working one.
 */
function MetricRow({
  label,
  from,
  target,
  current,
}: {
  label: string;
  from: string | null;
  target: string;
  current: string | null;
}) {
  return (
    <KeyValueRow label={label} mono>
      <span className="flex flex-wrap items-baseline gap-x-2">
        {current === null ? (
          <span className="font-sans text-[11px] text-warn">no reading</span>
        ) : (
          <span>{current}</span>
        )}
        <span className="font-sans text-[11px] text-fg-fnt">
          against {target}
          {from ? ` · ${from}` : ""}
        </span>
      </span>
    </KeyValueRow>
  );
}

export function Governance({ query }: { query: ConnectionsQuery }) {
  const conns = query.data;
  if (!conns) return null;
  const scaling = autoscalers(conns);
  const protecting = budgets(conns);
  if (scaling.length === 0 && protecting.length === 0) return null;

  return (
    <>
      {scaling.length > 0 && (
        <Section>
          <SectionHeader
            title="Autoscaling"
            count={
              scaling.length > 1
                ? `${scaling.length} autoscalers claim this — each undoes the other`
                : "what sets the replica count, and why"
            }
          />
          <div>
            {scaling.map((auto) => {
              const finding = autoscalerFinding(auto);
              return (
                <div key={auto.object.name} className="pb-1">
                  <KeyValueRow label="Autoscaler">
                    <ResourceRef
                      kind={auto.object.kind}
                      name={auto.object.name}
                      namespace={auto.object.namespace}
                      showKind={false}
                    />
                  </KeyValueRow>
                  <KeyValueRow label="Range">
                    {autoscalerRange(auto.facts)}
                  </KeyValueRow>
                  <KeyValueRow label="Replicas" mono>
                    {autoscalerReplicas(auto.facts)}
                  </KeyValueRow>
                  {metricReadings(auto.facts).map((metric) => (
                    <MetricRow
                      key={metric.key}
                      label={metric.label}
                      from={metric.from}
                      target={metric.target}
                      current={metric.current}
                    />
                  ))}
                  {finding && <FindingLine finding={finding} />}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {protecting.length > 0 && (
        <Section>
          <SectionHeader
            title="Disruption budget"
            count="what a node drain has to respect"
          />
          <div>
            {protecting.map((budget) => {
              const finding = budgetFinding(budget);
              return (
                <div key={budget.object.name} className="pb-1">
                  <KeyValueRow label="Budget">
                    <ResourceRef
                      kind={budget.object.kind}
                      name={budget.object.name}
                      namespace={budget.object.namespace}
                      showKind={false}
                    />
                  </KeyValueRow>
                  <KeyValueRow label="Requires">
                    {budgetRule(budget.facts)}
                  </KeyValueRow>
                  <KeyValueRow label="Right now" mono>
                    {budgetRoom(budget.facts)}
                  </KeyValueRow>
                  {finding && <FindingLine finding={finding} />}
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </>
  );
}
