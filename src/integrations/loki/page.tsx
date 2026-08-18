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
  const t = useT();
  const scope = useNamespaceScope();
  const { namespaces } = useClusterSummary();

  const asked = [
    ...new Set([...scope.scope, ...namespaces.map((entry) => entry.name)]),
  ].slice(0, SAMPLE);
  const skipped = Math.max(0, namespaces.length - asked.length);

  const found = useQuery({
    queryKey: ["loki", "coverage", asked.join(",")],
    queryFn: () => coverage(asked),
    enabled: asked.length > 0,
    staleTime: ROUTING_STALE,
  });

  if (found.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not ask this Loki anything
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
        description="Whether the Loki this cluster is pointed at holds this cluster's logs — which a connection test cannot tell you, because an address that answers LogQL says nothing about whose lines are behind it."
      />

      {asked.length === 0 ? (
        <p className="max-w-[68ch] text-[11.5px] text-fg-mut">
          This cluster&rsquo;s namespaces could not be read, so there is nothing
          to compare against what Loki holds.
        </p>
      ) : found.isPending ? (
        <p className="text-xs text-fg-fnt">Asking it for a line…</p>
      ) : !found.data ? null : (
        <Section>
          <SectionHeader
            title="Namespaces it has lines for"
            count={`last ${Math.round(found.data.windowMs / 60_000)} minutes`}
            description="One line is proof, so one line is all that is asked for. A namespace that wrote nothing in the window is not evidence either way — which is why an empty answer is drawn as a question and not as a verdict."
          />
          <div className="flex flex-col gap-1.5">
            {found.data.namespaces.map((entry) => (
              <Chain key={entry.namespace}>
                <Column label="Namespace">
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
                      ? "refused the query"
                      : entry.holds
                        ? "has lines"
                        : "nothing in the window"}
                  </Cell>
                </Column>
              </Chain>
            ))}
          </div>

          {skipped > 0 && (
            <p className="mt-3 text-[11px] text-fg-fnt">
              {skipped} more{" "}
              {skipped === 1 ? "namespace was" : "namespaces were"} not asked
              about — the check is one query each, and a page that cost a
              hundred of them to say &ldquo;yes&rdquo; would not be worth
              opening.
            </p>
          )}

          {empty && empty.length === found.data.namespaces.length && (
            <div className="mt-3">
              <Finding
                tone="err"
                title="This Loki holds none of this cluster's namespaces"
              >
                Not one of the namespaces asked about has a line in the last
                hour. The address answers LogQL — which is all the connection
                test proved — so what is behind it is most likely another
                cluster&rsquo;s logs, and the history offer in the log viewer
                will keep answering with nothing.
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
                A refusal is not an absence. Nothing is claimed about these
                namespaces either way.
              </Finding>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
