/**
 * Loki: does it hold this cluster's logs.
 *
 * The same shape Prometheus's page has, for the same reason — a configured
 * vendor supplies powers rather than objects, and the one thing no other
 * screen can hold is a question about the connection itself. Here it is
 * sharper than a probe can reach: an address that answers LogQL proves
 * nothing about *whose* logs are behind it, and a Loki holding another
 * cluster's namespaces answers every query with an empty page.
 *
 * That empty page is the quietest failure in this app. The history offer is
 * only ever drawn where the reader has just been told the live log has
 * nothing left to show, so an empty answer confirms the exact belief it
 * exists to correct: the lines are gone. They are not gone. They are in a
 * Loki nobody pointed this at.
 */

import { useQuery } from "@tanstack/react-query";

import { Section, SectionHeader } from "@/components/ui/section";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import { Cell, Chain, Column, Finding } from "../page-kit";
import { ROUTING_STALE } from "../ingress";
import { coverage, verdict } from "./coverage";
import { useT } from "@/i18n/useT";

/**
 * How many namespaces are worth one query each.
 *
 * The check is a query per namespace, so a hundred-namespace cluster would
 * cost a hundred requests to say "yes". The reader's own scope comes first
 * and the rest of the cluster is sampled; what was left out is said out loud
 * rather than presented as the whole answer.
 */
const SAMPLE = 12;

export default function LokiPage() {
  const context = useClusterStore((state) => state.currentContext);
  const t = useT();
  const scope = useNamespaceScope();
  const { namespaces } = useClusterSummary();

  const asked = [
    ...new Set([...scope.scope, ...namespaces.map((entry) => entry.name)]),
  ].slice(0, SAMPLE);
  const skipped = Math.max(0, namespaces.length - asked.length);

  const found = useQuery({
    queryKey: [context, "loki", "coverage", asked.join(",")],
    queryFn: () => coverage(asked),
    enabled: asked.length > 0,
    staleTime: ROUTING_STALE,
  });

  if (found.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          {t("empty", "lokiCouldNotAsk")}
        </h2>
        <p className="text-[11px] text-fg-fnt">{found.error.message}</p>
      </Section>
    );
  }

  const state = found.data ? verdict(found.data) : null;
  const refused = found.data?.namespaces.filter(
    (entry) => entry.problem !== null
  );
  const empty = found.data?.namespaces.filter(
    (entry) => entry.problem === null && !entry.holds
  );

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Loki"
        count={state?.text}
        description={t("empty", "lokiPageDescription")}
      />

      {asked.length === 0 ? (
        <p className="max-w-[68ch] text-[11.5px] text-fg-mut">
          {t("empty", "lokiNoNamespaces")}
        </p>
      ) : found.isPending ? (
        <p className="text-xs text-fg-fnt">{t("empty", "lokiAsking")}</p>
      ) : !found.data ? null : (
        <Section>
          <SectionHeader
            title={t("empty", "lokiNamespacesTitle")}
            count={t("count", "lastMinutes", {
              n: Math.round(found.data.windowMs / 60_000),
            })}
            description={t("empty", "lokiOneLineProof")}
          />
          <div className="flex flex-col gap-1.5">
            {found.data.namespaces.map((entry) => (
              <Chain key={entry.namespace}>
                <Column label={t("columns", "namespace")}>
                  <Cell>
                    <span className="font-mono">{entry.namespace}</span>
                  </Cell>
                </Column>
                <Column label="Loki">
                  <Cell
                    bad={entry.problem !== null}
                    warn={entry.problem === null && !entry.holds}
                    title={entry.problem ?? undefined}
                  >
                    {entry.problem !== null
                      ? t("empty", "lokiRefusedQuery")
                      : entry.holds
                        ? t("empty", "lokiHasLines")
                        : t("empty", "lokiNothingInWindow")}
                  </Cell>
                </Column>
              </Chain>
            ))}
          </div>

          {skipped > 0 && (
            <p className="mt-3 text-[11px] text-fg-fnt">
              {t("count", "namespacesNotAsked", { n: skipped })}
            </p>
          )}

          {empty && empty.length === found.data.namespaces.length && (
            <div className="mt-3">
              <Finding tone="err" title={t("empty", "lokiHoldsNone")}>
                {t("empty", "lokiHoldsNoneBody")}
              </Finding>
            </div>
          )}

          {refused && refused.length > 0 && (
            <div className="mt-3">
              <Finding
                tone="warn"
                title={t("count", "queriesRefused", { n: refused.length })}
                verbatim={refused[0].problem}
              >
                {t("empty", "lokiRefusalNotAbsence")}
              </Finding>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
