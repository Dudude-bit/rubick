/**
 * Prometheus: is this the right one, and does it have what the app asks it
 * for.
 *
 * The page nearly did not exist, and the reason it does is worth stating.
 * Prometheus supplies powers rather than objects — its facts belong on the
 * pod and the node they are about, and a page listing them again would be a
 * worse copy of a chart the reader already has. What it *does* own, and what
 * no other screen can hold, is a question about the connection itself:
 * **whether the Prometheus somebody typed an address for is watching this
 * cluster at all.**
 *
 * A probe cannot answer that. It proves the address speaks PromQL, so the
 * organisation's central Prometheus — scraping four clusters, none of them
 * this one — connects, reads as healthy, and draws charts about somebody
 * else's pods. Every number real, none of them yours.
 *
 * So the page is one comparison and one inventory: the nodes it knows against
 * the nodes this cluster has, and the metric families the app's queries are
 * built on. Nothing here is a chart.
 */

import { useQuery } from "@tanstack/react-query";

import { Section, SectionHeader } from "@/components/ui/section";
import { useWakeOnVisit } from "@/hooks/useClusterForwards";
import { Cell, Chain, Column, Finding } from "../page-kit";
import { ROUTING_STALE } from "../ingress";
import prometheus from "./index";
import { FAMILIES, coverage, verdict } from "./coverage";

export default function PrometheusPage() {
  // The tunnel died with the last app instance; opening this page is as
  // deliberate as pressing the sidebar row, so it wakes the saved forward.
  useWakeOnVisit("prometheus");

  const found = useQuery({
    queryKey: ["prometheus", "coverage"],
    queryFn: coverage,
    // A cluster's node set changes with a scale-up, not by the second, and
    // this is a diagnosis rather than a reading.
    staleTime: ROUTING_STALE,
  });

  // The saved address, so every metric on this page is a doorway into the
  // Prometheus graph UI rather than a wall of names to retype there.
  const saved = useQuery({
    queryKey: ["prometheus", "page-address"],
    queryFn: () => prometheus.connect!.read(),
    staleTime: ROUTING_STALE,
  });
  const base = saved.data?.url?.replace(/\/+$/, "") ?? null;
  const graph = (expression: string) =>
    base === null
      ? null
      : `${base}/graph?g0.expr=${encodeURIComponent(expression)}&g0.tab=0`;

  if (found.error) {
    return (
      <Section className="max-w-[64ch] py-8">
        <h2 className="text-[13px] font-semibold tracking-tight text-err">
          Could not ask this Prometheus anything
        </h2>
        <p className="text-[11px] text-fg-fnt">{found.error.message}</p>
      </Section>
    );
  }

  const state = found.data ? verdict(found.data) : null;

  return (
    <div className="flex flex-col gap-[22px]">
      <SectionHeader
        title="Prometheus"
        count={state?.text}
        description="Whether the Prometheus this cluster is pointed at is scraping this cluster — which a connection test cannot tell you — and whether it holds the metrics the app's history is built on."
      />

      {found.isPending ? (
        <p className="text-xs text-fg-fnt">Asking it what it knows…</p>
      ) : !found.data ? null : (
        <>
          <Section>
            <SectionHeader
              title="Which cluster it is watching"
              description="Node names, because nothing else identifies a cluster from the outside: a namespace called default exists everywhere and a pod name is gone by tomorrow."
            />
            {found.data.problem ? (
              <Finding tone="warn" title="The comparison could not be made">
                {found.data.problem}
              </Finding>
            ) : (
              <div className="flex flex-col gap-3">
                <Chain>
                  <Column label="This cluster">
                    <Cell>{found.data.clusterNodes} nodes</Cell>
                  </Column>
                  <Column label="It knows">
                    <Cell
                      bad={found.data.matched === 0}
                      warn={found.data.unseen.length > 0}
                    >
                      {found.data.matched} of them
                    </Cell>
                  </Column>
                  <Column label="Also scraping">
                    <Cell
                      title={found.data.foreign.join(", ") || undefined}
                      under={
                        found.data.foreign.length > 0
                          ? "other clusters, or nodes this one has lost"
                          : undefined
                      }
                    >
                      {found.data.foreign.length === 0
                        ? "nothing else"
                        : `${found.data.foreign.length} other nodes`}
                    </Cell>
                  </Column>
                </Chain>

                {found.data.matched === 0 && (
                  <Finding
                    tone="err"
                    title="This Prometheus is not watching this cluster"
                  >
                    Not one of this cluster&rsquo;s {found.data.clusterNodes}{" "}
                    nodes appears in it. The address answers PromQL — which is
                    all the connection test proved — and every history and
                    volume figure the app draws from it is about somebody
                    else&rsquo;s cluster.
                  </Finding>
                )}

                {found.data.matched > 0 && found.data.unseen.length > 0 && (
                  <Finding
                    tone="warn"
                    title={`${found.data.unseen.length} of this cluster's nodes are not scraped`}
                  >
                    <span className="font-mono">
                      {found.data.unseen.join(", ")}
                    </span>{" "}
                    are in the cluster and not in Prometheus, so a pod that
                    happens to be scheduled on one of them draws an empty
                    history — which looks exactly like a pod that used nothing.
                  </Finding>
                )}
              </div>
            )}
          </Section>

          <Section>
            <SectionHeader
              title="What the app asks it for"
              description="The exact metric names the queries use. A family that is absent answers every query with an empty series, and an empty series is drawn as a flat chart rather than as a gap — so the absence is named here instead."
            />
            <div className="flex flex-col gap-1.5">
              {FAMILIES.map((family) => {
                const absent = found.data.missing.some(
                  (entry) => entry.metric === family.metric
                );
                return (
                  <Chain key={family.metric}>
                    <Column label="Metric">
                      <Cell
                        bad={absent}
                        title={family.metric}
                        under={
                          typeof found.data.series[family.metric] === "number"
                            ? `${found.data.series[family.metric]} series right now`
                            : undefined
                        }
                      >
                        {graph(family.metric) ? (
                          <a
                            href={graph(family.metric)!}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-info underline-offset-2 hover:underline"
                          >
                            {family.metric}
                          </a>
                        ) : (
                          <span className="font-mono">{family.metric}</span>
                        )}
                      </Cell>
                    </Column>
                    <Column label="Powers">
                      <Cell title={family.powers}>{family.powers}</Cell>
                    </Column>
                    <Column label="Scraped from">
                      <Cell under={absent ? "no series at all" : undefined}>
                        {family.from}
                      </Cell>
                    </Column>
                  </Chain>
                );
              })}
            </div>
            {found.data.missing.length > 0 && (
              <div className="mt-3">
                <Finding
                  tone="err"
                  title={`${found.data.missing.length} of the four families are absent`}
                >
                  Nothing in this Prometheus carries{" "}
                  <span className="font-mono">
                    {found.data.missing
                      .map((family) => family.metric)
                      .join(", ")}
                  </span>
                  . The surfaces built on them draw the window this app watched
                  itself and dim the longer ranges — they do not report an
                  error, because an empty answer is a valid one.
                </Finding>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
