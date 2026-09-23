/**
 * Cilium: which pods a policy actually reaches.
 *
 * The CRD views answer "what does this policy say". This page answers the
 * question a person actually has — **is this pod covered, and by what** —
 * which needs the two sides joined: a policy names labels, and a
 * `CiliumEndpoint` carries the labels Cilium itself resolved for the pod.
 * Neither list can say it alone.
 *
 * The row is the endpoint rather than the policy, because the dangerous
 * answer is about a pod and not about a rule: a pod nothing selects is
 * unrestricted, and a pod selected *only* by policies the operator threw
 * away looks covered from every other screen in this app. The policies are
 * under it, with the rejected ones marked.
 */

import { useMemo } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { useT } from "@/i18n/useT";
import {
  Cell,
  Chain,
  Column,
  Finding,
  TroubleList,
  TroubleRow,
} from "../page-kit";
import type { Tone } from "../page-kit";
import { coverageOf, type Coverage } from "./coverage";
import { KINDS, usePicture } from "./data";
import { enforcementOf } from "./model";

const VERDICT_TONE: Record<Coverage["verdict"], Tone> = {
  covered: "ok",
  // Not red: a pod nobody wrote a policy for is a choice, and most clusters
  // have made it for most of their pods. Red here would paint a default
  // cluster in failures and hide the row below, which is the real one.
  unrestricted: "warn",
  onlyRejected: "err",
  cannotSay: "warn",
};

const VERDICT_WORD: Record<
  Coverage["verdict"],
  | "ciliumCovered"
  | "ciliumUnrestricted"
  | "ciliumOnlyRejected"
  | "ciliumCannotSay"
> = {
  covered: "ciliumCovered",
  unrestricted: "ciliumUnrestricted",
  onlyRejected: "ciliumOnlyRejected",
  cannotSay: "ciliumCannotSay",
};

export default function CiliumPage() {
  const t = useT();
  const picture = usePicture();

  const coverage = useMemo(
    () =>
      picture.data
        ? coverageOf(
            picture.data.endpoints,
            picture.data.policies,
            picture.data.clusterwide
          )
        : [],
    [picture.data]
  );

  const onlyRejected = coverage.filter((one) => one.verdict === "onlyRejected");
  const unrestricted = coverage.filter((one) => one.verdict === "unrestricted");
  const rejected = [
    ...(picture.data?.policies ?? []),
    ...(picture.data?.clusterwide ?? []),
  ].filter((policy) => enforcementOf(policy).state === "rejected");

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <SectionHeader
          title="Cilium"
          description={t("empty", "ciliumPageDescription")}
        />
        <div className="flex flex-col gap-2">
          {rejected.length > 0 && (
            <Finding
              tone="err"
              title={t("readings", "ciliumFindingRejected", {
                n: rejected.length,
              })}
            >
              {rejected.map((policy) => policy.name).join(", ")}
            </Finding>
          )}
          {onlyRejected.length > 0 && (
            <Finding
              tone="err"
              title={t("readings", "ciliumFindingOnlyRejected", {
                n: onlyRejected.length,
              })}
            />
          )}
          {unrestricted.length > 0 && (
            <Finding
              tone="warn"
              title={t("readings", "ciliumFindingUnrestricted", {
                n: unrestricted.length,
              })}
            />
          )}
        </div>
      </Section>

      <Section>
        <TroubleList
          items={coverage}
          severityOf={severityOfCoverage}
          searchable={searchableCoverage}
          filter={{
            placeholder: t("action", "searchEllipsis"),
            label: t("action", "searchEllipsis"),
          }}
          // The findings above say what is wrong; no row opens itself.
          autoOpen={{ when: "err", upTo: 0 }}
          noMatch={(query) => t("empty", "nothingMatchesQuery", { query })}
          keyOf={(one) =>
            one.endpoint.uid || `${one.endpoint.namespace}/${one.endpoint.name}`
          }
          renderRow={(one, { last }) => <CoverageRow one={one} last={last} />}
        />
      </Section>
    </div>
  );
}

/** One endpoint and the policies that select it. */
function CoverageRow({ one, last }: { one: Coverage; last: boolean }) {
  const t = useT();
  return (
    <TroubleRow
      key={one.endpoint.uid || `${one.endpoint.namespace}/${one.endpoint.name}`}
      title={one.endpoint.name}
      reference={{
        kind: "CiliumEndpoint",
        name: one.endpoint.name,
        namespace: one.endpoint.namespace,
        crd: KINDS.endpoints,
      }}
      meta={one.endpoint.namespace}
      state={{
        text: t("readings", VERDICT_WORD[one.verdict]),
        tone: VERDICT_TONE[one.verdict],
      }}
      last={last}
    >
      {one.selecting.length === 0 ? (
        <p className="text-[11.5px] text-fg-mut">
          {t("readings", "ciliumNothingSelects")}
        </p>
      ) : (
        <Chain>
          {one.selecting.map((selecting) => (
            <Column
              key={`${selecting.policy.namespace ?? "*"}/${selecting.policy.name}`}
              label={
                selecting.clusterwide
                  ? t("columns", "ciliumClusterwide")
                  : t("columns", "ciliumNamespaced")
              }
            >
              <Cell
                bad={!selecting.enforcing}
                under={
                  selecting.enforcing
                    ? undefined
                    : t("readings", "ciliumEnforcesNothing")
                }
              >
                {selecting.policy.name}
              </Cell>
            </Column>
          ))}
        </Chain>
      )}
      {one.unreadable > 0 && (
        <p className="mt-1 text-[11.5px] text-warn">
          {t("readings", "ciliumUnreadablePolicies", {
            n: one.unreadable,
          })}
        </p>
      )}
    </TroubleRow>
  );
}

const severityOfCoverage = (one: Coverage) => {
  const tone = VERDICT_TONE[one.verdict];
  return tone === "ok" ? null : tone;
};

const searchableCoverage = (one: Coverage) => [
  one.endpoint.name,
  one.endpoint.namespace,
  ...one.selecting.map((selecting) => selecting.policy.name),
];
