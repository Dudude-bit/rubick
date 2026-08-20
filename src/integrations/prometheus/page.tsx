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
import { useClusterStore } from "@/stores/clusterStore";
import { Cell, Chain, Column, Finding } from "../page-kit";
import { ROUTING_STALE } from "../ingress";
import prometheus from "./index";
import { FAMILIES, coverage, verdict } from "./coverage";
import { useT } from "@/i18n/useT";

export default function PrometheusPage() {
  const context = useClusterStore((state) => state.currentContext);
  const t = useT();
  // The tunnel died with the last app instance; opening this page is as
  // deliberate as pressing the sidebar row, so it wakes the saved forward.
  useWakeOnVisit("prometheus");

  const found = useQuery({
    queryKey: [context, "prometheus", "coverage"],
    queryFn: coverage,
    // A cluster's node set changes with a scale-up, not by the second, and
    // this is a diagnosis rather than a reading.
    staleTime: ROUTING_STALE,
  });

  // The saved address, so every metric on this page is a doorway into the
  // Prometheus graph UI rather than a wall of names to retype there.
  const saved = useQuery({
    queryKey: [context, "prometheus", "page-address"],
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
          {t("empty", "promCouldNotAsk")}
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
        description={t("empty", "promPageDescription")}
      />

      {found.isPending ? (
        <p className="text-xs text-fg-fnt">{t("empty", "promAsking")}</p>
      ) : !found.data ? null : (
        <>
          <Section>
            <SectionHeader
              title={t("empty", "promWhichCluster")}
              description={t("empty", "promNodeNamesWhy")}
            />
            {found.data.problem ? (
              <Finding tone="warn" title={t("empty", "promComparisonFailed")}>
                {found.data.problem}
              </Finding>
            ) : (
              <div className="flex flex-col gap-3">
                <Chain>
                  <Column label={t("columns", "thisCluster")}>
                    <Cell>
                      {t("count", "nodes", { n: found.data.clusterNodes })}
                    </Cell>
                  </Column>
                  <Column label={t("columns", "itKnows")}>
                    <Cell
                      bad={found.data.matched === 0}
                      warn={found.data.unseen.length > 0}
                    >
                      {t("count", "ofThem", { n: found.data.matched })}
                    </Cell>
                  </Column>
                  <Column label={t("columns", "alsoScraping")}>
                    <Cell
                      title={found.data.foreign.join(", ") || undefined}
                      under={
                        found.data.foreign.length > 0
                          ? t("empty", "promForeignNodes")
                          : undefined
                      }
                    >
                      {found.data.foreign.length === 0
                        ? t("empty", "nothingElse")
                        : t("count", "otherNodes", {
                            n: found.data.foreign.length,
                          })}
                    </Cell>
                  </Column>
                </Chain>

                {found.data.matched === 0 && (
                  <Finding tone="err" title={t("empty", "promNotWatching")}>
                    {t("empty", "promNotWatchingBody", {
                      n: found.data.clusterNodes,
                    })}
                  </Finding>
                )}

                {found.data.matched > 0 && found.data.unseen.length > 0 && (
                  <Finding
                    tone="warn"
                    title={t("count", "nodesNotScraped", {
                      n: found.data.unseen.length,
                    })}
                  >
                    <span className="font-mono">
                      {found.data.unseen.join(", ")}
                    </span>{" "}
                    {t("empty", "promUnseenNodesBody")}
                  </Finding>
                )}
              </div>
            )}
          </Section>

          <Section>
            <SectionHeader
              title={t("empty", "promWhatAppAsks")}
              description={t("empty", "promFamiliesWhy")}
            />
            <div className="flex flex-col gap-1.5">
              {FAMILIES.map((family) => {
                const absent = found.data.missing.some(
                  (entry) => entry.metric === family.metric
                );
                return (
                  <Chain key={family.metric}>
                    <Column label={t("columns", "metric")}>
                      <Cell
                        bad={absent}
                        title={family.metric}
                        under={
                          typeof found.data.series[family.metric] === "number"
                            ? t("count", "seriesRightNow", {
                                n: Number(found.data.series[family.metric]),
                              })
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
                    <Column label={t("columns", "powers")}>
                      <Cell title={family.powers}>{family.powers}</Cell>
                    </Column>
                    <Column label={t("columns", "scrapedFrom")}>
                      <Cell
                        under={absent ? t("empty", "noSeriesAtAll") : undefined}
                      >
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
                  title={t("count", "familiesAbsent", {
                    n: found.data.missing.length,
                  })}
                >
                  {t("empty", "promNothingCarries")}{" "}
                  <span className="font-mono">
                    {found.data.missing
                      .map((family) => family.metric)
                      .join(", ")}
                  </span>
                  {t("empty", "promMissingFamiliesTail")}
                </Finding>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
